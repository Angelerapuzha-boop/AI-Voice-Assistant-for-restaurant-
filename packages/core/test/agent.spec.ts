import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import { getOrderWithItems } from "../src/domain/orders";
import {
  FakeLlm,
  findItemByName,
  modifierId,
  resetTransactionalData,
  setupTestDb,
  textTurn,
  toolTurn,
  type TestContext,
} from "./helpers";

let ctx: TestContext;
let db: pg.Pool;

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
});

// Agent context pinned to a Wednesday evening when the restaurant is open.
function agentCtx(): AgentContext {
  return {
    db,
    restaurant: ctx.restaurant,
    settings: ctx.settings,
    hours: ctx.hours,
    callerNumber: "+61400000001",
    now: () => new Date("2026-09-09T19:00:00+08:00"),
  };
}

describe("agent engine + tools", () => {
  it("full ordering flow with the summary-before-confirm guard (scenarios 1 & 7)", async () => {
    const item = await findItemByName(db, "Chicken Meatbox");
    const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");

    const llm = new FakeLlm([
      // turn 1: caller wants a chicken meatbox -> draft + add + reply
      toolTurn("create_order_draft", { orderType: "takeaway" }, "tu_1"),
      toolTurn("add_order_item", { menuItemId: item.id, quantity: 1, modifierIds: [base] }, "tu_2"),
      textTurn("One chicken Meatbox with chips and salad. Can I grab a name?"),
      // turn 2: name + attempt to confirm WITHOUT summary -> guard error -> summary -> confirm
      toolTurn("set_order_details", { customerName: "Daniel", pickupTime: "ASAP" }, "tu_3"),
      toolTurn("confirm_order", {}, "tu_4"), // must be rejected by the guard
      toolTurn("get_order_summary", {}, "tu_5"),
      textTurn("So that's one chicken Meatbox, $19.95 total. All good?"),
      // turn 3: caller says yes -> confirm -> goodbye + end_call in one turn
      toolTurn("confirm_order", {}, "tu_6"),
      [
        { type: "text" as const, text: "Perfect, we've got your order. Thanks for calling Meatbox!" },
        { type: "tool_use" as const, id: "tu_7", name: "end_call", input: { reason: "done" } },
        { type: "stop" as const, reason: "tool_use" },
      ],
    ]);

    const agent = new OrderAgent(llm, agentCtx());

    const turn1 = await agent.handleTurn("I'll get a chicken meatbox with chips and salad");
    expect(turn1.toolCalls.map((c) => c.name)).toEqual(["create_order_draft", "add_order_item"]);
    expect(turn1.toolCalls[1]!.result.total).toBe("$19.95");

    const turn2 = await agent.handleTurn("Daniel, pickup ASAP");
    const confirmAttempt = turn2.toolCalls.find((c) => c.name === "confirm_order");
    expect(confirmAttempt!.result.error).toMatch(/read it back|get_order_summary/i);

    const turn3 = await agent.handleTurn("Yes that's right");
    const confirm = turn3.toolCalls.find((c) => c.name === "confirm_order");
    expect(confirm!.result.confirmed).toBe(true);
    expect(String(confirm!.result.orderNumber)).toMatch(/^MB\d+$/);
    expect(turn3.endCall).toBe(true);

    // Order is really in the database with the caller's phone from caller ID
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.status).toBe("new");
    expect(order!.customerPhone).toBe("+61400000001");
    expect(order!.customerName).toBe("Daniel");

    // Owner SMS was enqueued atomically with the confirmation (scenario 8 setup)
    const sms = await db.query(
      `SELECT kind, to_number FROM notification_attempts WHERE order_id = $1`,
      [order!.id],
    );
    expect(sms.rows.some((r) => (r as { kind: string }).kind === "owner_sms")).toBe(true);
  });

  it("reports sold-out items instead of substituting (scenario 3)", async () => {
    const item = await findItemByName(db, "Chicken Kebab");
    await db.query(`UPDATE menu_items SET is_sold_out = true WHERE id = $1`, [item.id]);
    const llm = new FakeLlm([
      toolTurn("create_order_draft", {}, "tu_1"),
      toolTurn("add_order_item", { menuItemId: item.id, quantity: 1 }, "tu_2"),
      textTurn("Sorry, the chicken kebab is sold out today — can I get you a lamb kebab instead?"),
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    const turn = await agent.handleTurn("chicken kebab please");
    const add = turn.toolCalls.find((c) => c.name === "add_order_item");
    expect(add!.result.error).toMatch(/not available/);
    await db.query(`UPDATE menu_items SET is_sold_out = false WHERE id = $1`, [item.id]);
  });

  it("returns real specials and never invents them (scenario 4)", async () => {
    const llm = new FakeLlm([
      toolTurn("get_daily_specials", {}, "tu_1"),
      textTurn("Today's special is the Half Chicken & Chips Deal for nineteen ninety-five."),
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    const turn = await agent.handleTurn("what's today's special?");
    const specials = turn.toolCalls[0]!.result.specials as { name: string; price: string }[];
    expect(specials[0]!.name).toBe("Half Chicken & Chips Deal");
    expect(specials[0]!.price).toBe("$19.95");
  });

  it("tells the model when there are no specials", async () => {
    await db.query(`UPDATE daily_specials SET active = false`);
    const llm = new FakeLlm([
      toolTurn("get_daily_specials", {}, "tu_1"),
      textTurn("No special today, but the mixed grill is popular."),
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    const turn = await agent.handleTurn("specials?");
    expect(turn.toolCalls[0]!.result.specials).toEqual([]);
    expect(String(turn.toolCalls[0]!.result.note)).toMatch(/never invent/i);
    await db.query(`UPDATE daily_specials SET active = true`);
  });

  it("search returns multiple matches for ambiguous requests (scenario 11)", async () => {
    const llm = new FakeLlm([
      toolTurn("search_menu", { query: "the box" }, "tu_1"),
      textTurn("Did you mean the regular Meatbox or the Small Meatbox?"),
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    const turn = await agent.handleTurn("I'll get the box");
    const matches = turn.toolCalls[0]!.result.matches as unknown[];
    expect(matches.length).toBeGreaterThan(1);
    expect(String(turn.toolCalls[0]!.result.note ?? "")).toMatch(/ask which one/i);
  });

  it("no reservation tool exists (scenario 5)", async () => {
    // Structural guarantee: nothing the model can call creates a booking.
    const { TOOL_DEFS } = await import("../src/agent/tools");
    for (const tool of TOOL_DEFS) {
      expect(tool.name).not.toMatch(/reserv|booking|table/i);
    }
  });

  it("dine-in orders confirm without a table booking (scenario 6)", async () => {
    const item = await findItemByName(db, "Lamb Pide");
    const llm = new FakeLlm([
      toolTurn("create_order_draft", { orderType: "dine_in", customerName: "Sam" }, "tu_1"),
      toolTurn("add_order_item", { menuItemId: item.id, quantity: 1 }, "tu_2"),
      toolTurn("get_order_summary", {}, "tu_3"),
      textTurn("One lamb pide for dine-in, $14.95. Correct?"),
      toolTurn("confirm_order", {}, "tu_4"),
      [
        { type: "text" as const, text: "Done — see you soon!" },
        { type: "tool_use" as const, id: "tu_5", name: "end_call", input: { reason: "done" } },
        { type: "stop" as const, reason: "tool_use" },
      ],
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    await agent.handleTurn("lamb pide to eat in, name's Sam");
    const turn2 = await agent.handleTurn("yes");
    const confirm = turn2.toolCalls.find((c) => c.name === "confirm_order");
    expect(confirm!.result.confirmed).toBe(true);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.orderType).toBe("dine_in");
  });

  it("recovers politely when the LLM fails, and gives up after two failures (scenario 9)", async () => {
    const failing = {
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncGenerator<never> {
        throw new Error("api down");
      },
    };
    const agent = new OrderAgent(failing, agentCtx());
    const turn1 = await agent.handleTurn("hello");
    expect(turn1.text).toMatch(/say it again/i);
    expect(turn1.endCall).toBe(false);
    const turn2 = await agent.handleTurn("hello?");
    expect(turn2.endCall).toBe(true);
    expect(turn2.text).toMatch(/call us back/i);
  });

  it("flags the draft for review via flag_for_review (scenario fallback)", async () => {
    const item = await findItemByName(db, "Chicken Kebab");
    const llm = new FakeLlm([
      toolTurn("create_order_draft", {}, "tu_1"),
      toolTurn("add_order_item", { menuItemId: item.id, quantity: 1 }, "tu_2"),
      textTurn("Got the kebab. What else?"),
      toolTurn("flag_for_review", { note: "caller line kept dropping" }, "tu_3"),
      [
        { type: "text" as const, text: "Sorry about the trouble — the team will follow up." },
        { type: "tool_use" as const, id: "tu_4", name: "end_call", input: { reason: "fallback" } },
        { type: "stop" as const, reason: "tool_use" },
      ],
    ]);
    const agent = new OrderAgent(llm, agentCtx());
    await agent.handleTurn("kebab");
    await agent.handleTurn("(garbled)");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.status).toBe("needs_review");
    expect(agent.state.outcome).toBe("NEEDS_REVIEW");
  });

  it("closed kitchen: ASAP pickup is rejected via set_order_details", async () => {
    const closedCtx: AgentContext = { ...agentCtx(), now: () => new Date("2026-09-09T14:00:00+08:00") };
    const item = await findItemByName(db, "Water");
    const llm = new FakeLlm([
      toolTurn("create_order_draft", {}, "tu_1"),
      toolTurn("add_order_item", { menuItemId: item.id, quantity: 1 }, "tu_2"),
      toolTurn("set_order_details", { customerName: "Jo", pickupTime: "ASAP" }, "tu_3"),
      textTurn("We open at 5 pm — should I put it down for 5:30?"),
    ]);
    const agent = new OrderAgent(llm, closedCtx);
    const turn = await agent.handleTurn("a water for right now please, I'm Jo");
    const details = turn.toolCalls.find((c) => c.name === "set_order_details");
    expect(details!.result.error).toMatch(/closed/i);
  });

  it("system prompt carries the no-bookings and allergy rules (scenarios 5 & 12)", async () => {
    const llm = new FakeLlm([textTurn("ok")]);
    const agent = new OrderAgent(llm, agentCtx());
    await agent.handleTurn("hi");
    const params = llm.seenParams[0] as { system: string };
    expect(params.system).toMatch(/don't take table bookings/i);
    expect(params.system).toMatch(/never guarantee an item is allergen-free/i);
    expect(params.system).toMatch(/cross-contact/);
  });
});
