import { EventEmitter } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createPool,
  env,
  getDb,
  getOrderWithItems,
  runMigrations,
  seed,
  type Llm,
  type LlmStreamEvent,
} from "@meatbox/core";
import { relayToken } from "../src/twilio-signature";
import { RelaySession } from "../src/relay-session";
import type { WebSocket } from "ws";

/**
 * Drives a RelaySession through the real ConversationRelay message protocol
 * with a fake WebSocket and a scripted LLM, against the real test database.
 *
 * NOTE: RelaySession uses getDb() (the app pool). For tests we point
 * DATABASE_URL at the test database before importing… but env is already
 * loaded, so instead we monkey-patch env.DATABASE_URL prior to first getDb().
 */

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function scripted(scripts: LlmStreamEvent[][]): Llm {
  return {
    stream() {
      const script = scripts.shift();
      if (!script) throw new Error("no more scripted turns");
      return (async function* () {
        for (const e of script) yield e;
      })();
    },
  };
}

const SECRET = "test-secret";

function makeSession(ws: FakeWs, llm: Llm, token: string) {
  return new RelaySession(ws as unknown as WebSocket, {
    createLlm: () => llm,
    verifyToken: (callSid, t) => t === relayToken(SECRET, callSid),
    token,
    log: () => undefined,
    // Pin the clock to a Wednesday evening when the kitchen is open.
    now: () => new Date("2026-09-09T19:00:00+08:00"),
    endDelayMs: 0, // no hang-up grace in tests
    prewarm: false, // would consume the scripted LLM's first act
  });
}

async function drain(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let chickenId = "";
let baseModId = "";

beforeAll(async () => {
  // Point the app pool at the test database BEFORE anything calls getDb().
  (env as { DATABASE_URL: string }).DATABASE_URL = env.TEST_DATABASE_URL;
  const db = getDb();
  await runMigrations(db);
  await seed(db);
  await db.query(
    `TRUNCATE order_item_modifiers, order_items, notification_attempts, call_events, orders, calls CASCADE`,
  );
  const item = await db.query(`SELECT id FROM menu_items WHERE name = 'Chicken Meatbox'`);
  chickenId = (item.rows[0] as { id: string }).id;
  const mod = await db.query(
    `SELECT m.id FROM menu_item_modifiers m
     JOIN menu_item_modifier_groups g ON g.id = m.group_id
     WHERE g.menu_item_id = $1 AND m.name = 'Chips & Salad'`,
    [chickenId],
  );
  baseModId = (mod.rows[0] as { id: string }).id;
});

beforeEach(async () => {
  await getDb().query(
    `TRUNCATE order_item_modifiers, order_items, notification_attempts, call_events, orders, calls CASCADE`,
  );
});

afterAll(async () => {
  await closeDb();
});

describe("RelaySession over the ConversationRelay protocol", () => {
  it("rejects an invalid token at setup", async () => {
    const ws = new FakeWs();
    let closed = false;
    ws.close = () => {
      closed = true;
    };
    makeSession(ws, scripted([]), "bad-token");
    ws.emit("message", Buffer.from(JSON.stringify({ type: "setup", callSid: "CA1" })));
    await drain();
    expect(closed).toBe(true);
  });

  it("streams text tokens and completes a full order; call record is written", async () => {
    const llm = scripted([
      [
        { type: "tool_use", id: "t1", name: "create_order_draft", input: { orderType: "takeaway" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        {
          type: "tool_use",
          id: "t2",
          name: "add_order_item",
          input: { menuItemId: chickenId, quantity: 1, modifierIds: [baseModId] },
        },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "tool_use", id: "t3", name: "set_order_details", input: { customerName: "Dan", pickupTime: "ASAP" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "tool_use", id: "t4", name: "get_order_summary", input: {} },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", text: "One chicken Meatbox, $19.95. " },
        { type: "text", text: "All good?" },
        { type: "stop", reason: "end_turn" },
      ],
      [
        { type: "tool_use", id: "t5", name: "confirm_order", input: {} },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "text", text: "Perfect, we've got your order. Thanks for calling Meatbox!" },
        { type: "tool_use", id: "t6", name: "end_call", input: { reason: "done" } },
        { type: "stop", reason: "tool_use" },
      ],
    ]);

    const ws = new FakeWs();
    makeSession(ws, llm, relayToken(SECRET, "CA100"));
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "setup", callSid: "CA100", from: "+61400000009", to: "+61455500004" }),
      ),
    );
    await drain();
    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "prompt", voicePrompt: "chicken meatbox with chips thanks, I'm Dan, ASAP", last: true }),
      ),
    );
    await drain(800);
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "prompt", voicePrompt: "yes that's right", last: true })),
    );
    await drain(800);

    // Text was streamed as tokens, and the session sent an end message.
    const textTokens = ws.sent.filter((m) => m.type === "text" && m.token !== "");
    expect(textTokens.length).toBeGreaterThan(2);
    expect(ws.sent.some((m) => m.type === "end")).toBe(true);

    const db = getDb();
    const orders = await db.query(`SELECT * FROM orders WHERE status = 'new'`);
    expect(orders.rows).toHaveLength(1);
    const order = orders.rows[0] as { customer_phone: string; public_order_number: string };
    expect(order.customer_phone).toBe("+61400000009"); // caller ID captured
    expect(order.public_order_number).toMatch(/^MB\d+$/);

    const calls = await db.query(`SELECT * FROM calls WHERE twilio_call_sid = 'CA100'`);
    const call = calls.rows[0] as { outcome: string; transcript: unknown[] };
    expect(call.outcome).toBe("ORDER_COMPLETED");
    expect(call.transcript.length).toBeGreaterThan(2);
  });

  it("preserves a confirmed order when the socket drops right after confirmation (scenario 10)", async () => {
    const llm = scripted([
      [
        { type: "tool_use", id: "t1", name: "create_order_draft", input: { customerName: "Dana" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        {
          type: "tool_use",
          id: "t2",
          name: "add_order_item",
          input: { menuItemId: chickenId, quantity: 1, modifierIds: [baseModId] },
        },
        { type: "stop", reason: "tool_use" },
      ],
      [
        { type: "tool_use", id: "t3", name: "get_order_summary", input: {} },
        { type: "stop", reason: "tool_use" },
      ],
      [{ type: "text", text: "That's $19.95 — correct?" }, { type: "stop", reason: "end_turn" }],
      [
        { type: "tool_use", id: "t4", name: "confirm_order", input: {} },
        { type: "stop", reason: "tool_use" },
      ],
      [{ type: "text", text: "Perfect— " }, { type: "stop", reason: "end_turn" }],
    ]);
    const ws = new FakeWs();
    makeSession(ws, llm, relayToken(SECRET, "CA200"));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "setup", callSid: "CA200", from: "+614" })));
    await drain();
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "prompt", voicePrompt: "one chicken meatbox, Dana", last: true })),
    );
    await drain(600);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "prompt", voicePrompt: "yes", last: true })));
    await drain(600);

    // Caller hangs up before the goodbye finishes.
    ws.readyState = 3;
    ws.emit("close");
    await drain();

    const db = getDb();
    const orders = await db.query(`SELECT status FROM orders`);
    expect(orders.rows).toHaveLength(1);
    // Confirmed order must survive the drop, NOT be downgraded to needs_review.
    expect((orders.rows[0] as { status: string }).status).toBe("new");
  });

  it("marks an unconfirmed draft as needs_review when the call drops (scenario 24)", async () => {
    const llm = scripted([
      [
        { type: "tool_use", id: "t1", name: "create_order_draft", input: { customerName: "Kim" } },
        { type: "stop", reason: "tool_use" },
      ],
      [
        {
          type: "tool_use",
          id: "t2",
          name: "add_order_item",
          input: { menuItemId: chickenId, quantity: 2, modifierIds: [baseModId] },
        },
        { type: "stop", reason: "tool_use" },
      ],
      [{ type: "text", text: "Two chicken Meatboxes. Anything else?" }, { type: "stop", reason: "end_turn" }],
    ]);
    const ws = new FakeWs();
    makeSession(ws, llm, relayToken(SECRET, "CA300"));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "setup", callSid: "CA300", from: "+614" })));
    await drain();
    ws.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "prompt", voicePrompt: "two chicken meatboxes for Kim", last: true })),
    );
    await drain(600);
    ws.emit("close");
    await drain();

    const db = getDb();
    const orders = await db.query(`SELECT status FROM orders`);
    expect((orders.rows[0] as { status: string }).status).toBe("needs_review");
    const calls = await db.query(`SELECT outcome FROM calls WHERE twilio_call_sid = 'CA300'`);
    expect((calls.rows[0] as { outcome: string }).outcome).toBe("CALL_DROPPED");
  });
});
