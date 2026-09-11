import crypto from "node:crypto";
import {
  buildMenuCatalog,
  buildSystemPrompt,
  endCall as endCallRow,
  env,
  executeTool,
  getDb,
  getDefaultRestaurant,
  getHours,
  getSettings,
  initialAgentState,
  isYes,
  recordCallEvent,
  startCall,
  type AgentContext,
  type AgentState,
  type TranscriptTurn,
} from "@meatbox/core";

/**
 * Order-engine bridge for the ElevenLabs Agents platform.
 *
 * The hosted agent does the listening/talking; every order action comes
 * back here as an authenticated webhook tool call and runs through the
 * SAME executeTool the ConversationRelay path uses — menu, prices, kitchen
 * notifications and the hard safety guards all stay server-side.
 *
 * Endpoints (registered in server.ts):
 *  - POST /elevenlabs/call-init    conversation-initiation webhook: creates
 *    the call row + session, returns the per-call prompt override (live
 *    menu catalog, caller ID, open state) and the greeting.
 *  - POST /elevenlabs/tools/:name  webhook tools -> executeTool.
 *  - POST /elevenlabs/post-call    HMAC-signed transcript webhook: writes
 *    the transcript and finalises the call row.
 *
 * A background sweep finalises sessions whose post-call webhook never
 * arrived (pulls the transcript from the ElevenLabs API when a key is
 * configured), so call rows can never zombie.
 */

/** Appended to the core prompt: behaviours specific to this platform. */
export const ELEVENLABS_PROMPT_APPENDIX = `

PLATFORM NOTES
- To hang up, use the end_call tool AFTER your goodbye line.
- Every tool needs conversation_id — it is filled in automatically.
- add_order_item pending flow: when it returns itemSavedAsPending with an 'ask' question, say ONLY that question. When the caller answers, call add_order_item AGAIN for the SAME item with their chosen option included in modifierNames.
- confirm_order requires caller_final_words: the caller's EXACT latest words agreeing to the order (for example "yep" or "yes lock it in"). Quote them verbatim — never paraphrase, never invent. If the caller has not clearly agreed, do not call it.`;

const IDLE_CHECK_MS = 3 * 60_000; // consider finalising after 3 min silence
const IDLE_GIVE_UP_MS = 10 * 60_000; // finalise without transcript after 10 min
const HMAC_TOLERANCE_SECS = 30 * 60;

export interface BridgeSession {
  conversationId: string;
  callSid: string;
  ctx: AgentContext;
  state: AgentState;
  startedAt: number;
  lastActivity: number;
}

interface FetchedConversation {
  status: string;
  transcript: TranscriptTurn[];
}

export interface BridgeDeps {
  now?: () => Date;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Pull a finished conversation from the platform (sweep fallback). */
  fetchConversation?: (conversationId: string, startedAtMs: number) => Promise<FetchedConversation | null>;
}

/** Constant-time comparison of the shared bridge secret. */
export function checkBridgeSecret(header: string | undefined, secret = env.ELEVENLABS_BRIDGE_SECRET): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify the `elevenlabs-signature: t=...,v0=...` HMAC on a post-call webhook. */
export function verifyPostCallSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret = env.ELEVENLABS_WEBHOOK_SECRET,
  nowSecs = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = parts.t ?? "";
  const v0 = parts.v0 ?? "";
  if (!t || !v0) return false;
  if (Math.abs(nowSecs - Number(t)) > HMAC_TOLERANCE_SECS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(v0);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The fallback twilio_call_sid when the platform gave us no call SID. */
function fallbackSid(conversationId: string): string {
  return `11l-${conversationId}`;
}

async function fetchConversationFromApi(
  conversationId: string,
  startedAtMs: number,
): Promise<FetchedConversation | null> {
  if (!env.ELEVENLABS_API_KEY) return null;
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`, {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status?: string;
    transcript?: { role?: string; message?: string | null; time_in_call_secs?: number }[];
  };
  return {
    status: data.status ?? "unknown",
    transcript: mapTranscript(data.transcript ?? [], startedAtMs),
  };
}

function mapTranscript(
  turns: { role?: string; message?: string | null; time_in_call_secs?: number }[],
  startedAtMs: number,
): TranscriptTurn[] {
  return turns
    .filter((t) => typeof t.message === "string" && t.message.length > 0)
    .map((t) => ({
      role: t.role === "agent" ? ("assistant" as const) : ("caller" as const),
      text: t.message as string,
      at: new Date(startedAtMs + (t.time_in_call_secs ?? 0) * 1000).toISOString(),
    }));
}

export class ElevenLabsBridge {
  private readonly sessions = new Map<string, BridgeSession>();
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly fetchConversation: (
    conversationId: string,
    startedAtMs: number,
  ) => Promise<FetchedConversation | null>;

  constructor(deps: BridgeDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((msg, extra) => console.log(msg, extra ?? ""));
    this.fetchConversation = deps.fetchConversation ?? fetchConversationFromApi;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  getSession(conversationId: string): BridgeSession | undefined {
    return this.sessions.get(conversationId);
  }

  private async createSession(
    conversationId: string,
    params: { callSid?: string; callerNumber?: string },
  ): Promise<BridgeSession> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const [settings, hours, menuCatalog] = await Promise.all([
      getSettings(db, restaurant.id),
      getHours(db, restaurant.id),
      buildMenuCatalog(db, restaurant.id),
    ]);
    const callSid = params.callSid || fallbackSid(conversationId);
    const call = await startCall(db, {
      restaurantId: restaurant.id,
      twilioCallSid: callSid,
      callerNumber: params.callerNumber ?? "",
    });
    await recordCallEvent(db, call.id, "elevenlabs_init", { conversationId });
    const session: BridgeSession = {
      conversationId,
      callSid,
      ctx: {
        db,
        restaurant,
        settings,
        hours,
        callId: call.id,
        callerNumber: params.callerNumber || undefined,
        now: this.now,
        menuCatalog,
      },
      state: initialAgentState(),
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(conversationId, session);
    return session;
  }

  /** Conversation-initiation webhook: per-call prompt + greeting override. */
  async handleInit(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const conversationId = String(body.conversation_id ?? "");
    if (!conversationId) return { status: 400, body: { error: "conversation_id required" } };
    const t0 = Date.now();
    const session = await this.createSession(conversationId, {
      callSid: body.call_sid ? String(body.call_sid) : undefined,
      callerNumber: body.caller_id ? String(body.caller_id) : undefined,
    });
    const prompt =
      buildSystemPrompt({
        restaurant: session.ctx.restaurant,
        settings: session.ctx.settings,
        hours: session.ctx.hours,
        callerNumber: session.ctx.callerNumber,
        now: this.now(),
        menuCatalog: session.ctx.menuCatalog,
      }) + ELEVENLABS_PROMPT_APPENDIX;
    this.log(`[11l] call-init ${Date.now() - t0}ms`, {
      conversationId,
      caller: session.ctx.callerNumber ?? "(none)",
    });
    return {
      status: 200,
      body: {
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          caller_number: session.ctx.callerNumber ?? "",
          restaurant_name: session.ctx.restaurant.name,
        },
        conversation_config_override: {
          agent: {
            prompt: { prompt },
            first_message: session.ctx.settings.aiGreeting,
          },
        },
      },
    };
  }

  /** Webhook tool call -> the shared order-engine executor. */
  async handleTool(
    name: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const conversationId = String(body.conversation_id ?? "");
    if (!conversationId) {
      return { status: 200, body: { error: "conversation_id was missing from the tool call." } };
    }
    // A missing session (service restarted mid-call) must not kill the
    // call: rebuild a caller-less session and keep serving.
    const session =
      this.sessions.get(conversationId) ?? (await this.createSession(conversationId, {}));
    session.lastActivity = Date.now();

    const input: Record<string, unknown> = { ...body };
    delete input.conversation_id;

    if (name === "confirm_order") {
      const words = String(input.caller_final_words ?? "").trim();
      delete input.caller_final_words;
      // HARD guard, model-independent (mirror of the relay path): the
      // caller's own words must be an explicit yes before an order can
      // reach the kitchen.
      session.state.currentCallerText = words;
      if (!words || !isYes(words)) {
        return {
          status: 200,
          body: {
            error:
              "The caller has not clearly said yes yet. Read the order back, WAIT for their explicit yes, then call confirm_order again with caller_final_words set to their exact words.",
          },
        };
      }
    }

    const t0 = Date.now();
    const result = await executeTool(session.ctx, session.state, name, input);
    if (result.itemSavedAsPending) {
      // The relay path completes pending items deterministically; here the
      // agent must re-call the tool itself, so rewrite the instruction.
      result.note =
        "Item saved as pending. Say ONLY the 'ask' question. When the caller answers, call add_order_item AGAIN for the same item with their chosen option added to modifierNames.";
    }
    this.log(`[11l] tool ${name} ${Date.now() - t0}ms`, { conversationId });
    return { status: 200, body: result };
  }

  /** Post-call webhook (raw body already signature-verified by the route). */
  async handlePostCall(rawBody: string): Promise<{ status: number; body: unknown }> {
    let parsed: { type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      return { status: 400, body: { error: "invalid JSON" } };
    }
    if (parsed.type !== "post_call_transcription" || !parsed.data) {
      return { status: 200, body: { ok: true, ignored: parsed.type ?? "unknown" } };
    }
    const data = parsed.data;
    const conversationId = String(data.conversation_id ?? "");
    const session = this.sessions.get(conversationId);
    const startedAtMs = session?.startedAt ?? Date.now();
    const transcript = mapTranscript(
      (data.transcript as { role?: string; message?: string | null; time_in_call_secs?: number }[]) ?? [],
      startedAtMs,
    );
    await this.finalize(conversationId, transcript);
    return { status: 200, body: { ok: true } };
  }

  /** Write the transcript, close the call row, drop the session. */
  private async finalize(conversationId: string, transcript: TranscriptTurn[]): Promise<void> {
    const db = getDb();
    const session = this.sessions.get(conversationId);
    let callId = session?.ctx.callId;
    if (!callId) {
      // Session lost (restart): recover the row via the deterministic SID.
      const res = await db.query(`SELECT id FROM calls WHERE twilio_call_sid = $1`, [
        fallbackSid(conversationId),
      ]);
      callId = (res.rows[0] as { id: string } | undefined)?.id;
    }
    if (!callId) {
      this.log(`[11l] finalize: no call row for conversation`, { conversationId });
      this.sessions.delete(conversationId);
      return;
    }
    if (transcript.length > 0) {
      await db.query(`UPDATE calls SET transcript = $2::jsonb WHERE id = $1`, [
        callId,
        JSON.stringify(transcript),
      ]);
    }
    await endCallRow(db, callId, {
      status: "completed",
      outcome: session?.state.outcome,
      orderId: session?.state.draftOrderId ?? undefined,
    });
    this.sessions.delete(conversationId);
    this.log(`[11l] call finalised`, { conversationId, turns: transcript.length });
  }

  /**
   * Safety net: finalise sessions whose post-call webhook never arrived.
   * Called every minute by the timer in server.ts (and directly by tests).
   */
  async sweep(nowMs = Date.now()): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      const idle = nowMs - session.lastActivity;
      if (idle < IDLE_CHECK_MS) continue;
      try {
        const remote = await this.fetchConversation(session.conversationId, session.startedAt);
        if (remote && (remote.status === "done" || remote.status === "failed")) {
          await this.finalize(session.conversationId, remote.transcript);
          continue;
        }
        if (!remote && idle >= IDLE_GIVE_UP_MS) {
          await this.finalize(session.conversationId, []);
        }
      } catch (err) {
        this.log(`[11l] sweep error`, { conversationId: session.conversationId, err: String(err) });
        if (idle >= IDLE_GIVE_UP_MS) await this.finalize(session.conversationId, []);
      }
    }
  }
}
