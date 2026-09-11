import crypto from "node:crypto";
import {
  appendTranscript,
  buildMenuCatalog,
  endCall,
  getDb,
  getDefaultRestaurant,
  getHours,
  getOrderWithItems,
  getSettings,
  recordCallEvent,
  OrderAgent,
  startCall,
  type Llm,
  type OrderWithItems,
  type ToolCallRecord,
} from "@meatbox/core";

/**
 * Admin "Test AI" backend: the exact same agent as the telephone path,
 * driven by typed text instead of speech. Sessions are in-memory (dev tool).
 */

interface SimSession {
  agent: OrderAgent;
  callId: string;
  createdAt: number;
}

const sessions = new Map<string, SimSession>();
const SESSION_TTL_MS = 60 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id);
  }
}

export async function createSimulatorSession(createLlm: (model?: string) => Llm): Promise<{
  sessionId: string;
  greeting: string;
}> {
  sweep();
  const db = getDb();
  const restaurant = await getDefaultRestaurant(db);
  const [settings, hours] = await Promise.all([
    getSettings(db, restaurant.id),
    getHours(db, restaurant.id),
  ]);
  const menuCatalog = await buildMenuCatalog(db, restaurant.id);
  const llm = createLlm(settings.aiModel || undefined); // throws if no API key
  const call = await startCall(db, {
    restaurantId: restaurant.id,
    twilioCallSid: `SIM-${crypto.randomUUID()}`,
    callerNumber: "simulator",
  });
  const agent = new OrderAgent(llm, {
    db,
    restaurant,
    settings,
    hours,
    callId: call.id,
    callerNumber: undefined, // simulator has no caller ID — agent should ask
    now: () => new Date(),
    menuCatalog,
  });
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { agent, callId: call.id, createdAt: Date.now() });
  void agent.prewarm(); // same cache warm-up as phone calls
  await appendTranscript(db, call.id, {
    role: "assistant",
    text: settings.aiGreeting,
    at: new Date().toISOString(),
  });
  return { sessionId, greeting: settings.aiGreeting };
}

export async function simulatorTurn(
  sessionId: string,
  text: string,
): Promise<{
  reply: string;
  toolCalls: ToolCallRecord[];
  order: OrderWithItems | null;
  endCall: boolean;
  confirmedOrderNumber: string | null;
  error?: string;
}> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Simulator session not found or expired.");
  const db = getDb();
  await appendTranscript(db, session.callId, {
    role: "caller",
    text,
    at: new Date().toISOString(),
  });
  const turnStarted = Date.now();
  const result = await session.agent.handleTurn(text);
  const turnMs = Date.now() - turnStarted;
  if (result.text) {
    await appendTranscript(db, session.callId, {
      role: "assistant",
      text: result.text,
      at: new Date().toISOString(),
    });
  }
  // Diagnostics parity with phone calls: simulator turns show up on the
  // Voice quality page with per-turn latency and tool rounds too.
  for (const call of result.toolCalls) {
    await recordCallEvent(db, session.callId, "tool_call", {
      name: call.name,
      input: call.input,
      result: call.result,
    });
  }
  await recordCallEvent(db, session.callId, turnMs > 8000 ? "slow_turn" : "turn_metrics", {
    turnMs,
    firstTokenMs: null,
    fillerSent: false,
    toolCalls: result.toolCalls.length,
    interrupted: result.interrupted,
    fastPath: result.fastPath ?? null,
    assistantWords: result.text ? result.text.trim().split(/\s+/).length : 0,
  });
  const orderId = session.agent.state.draftOrderId;
  const order = orderId ? await getOrderWithItems(db, orderId) : null;
  if (result.endCall) {
    await endCall(db, session.callId, {
      status: "completed",
      outcome: session.agent.state.outcome,
    });
    sessions.delete(sessionId);
  }
  return {
    reply: result.text,
    toolCalls: result.toolCalls,
    order,
    endCall: result.endCall,
    confirmedOrderNumber: session.agent.state.confirmedOrderNumber,
    error: result.error,
  };
}
