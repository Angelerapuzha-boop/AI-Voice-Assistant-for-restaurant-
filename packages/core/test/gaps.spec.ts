import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import { addOrderItem, confirmOrder, createDraft } from "../src/domain/orders";
import { recalcQueueEstimates } from "../src/domain/eta";
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
  await db.query(`UPDATE restaurant_settings SET accepting_orders = true, pause_reason = ''`);
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
  await db.query(`UPDATE restaurant_settings SET accepting_orders = true, pause_reason = ''`);
  await db.query(`UPDATE menu_items SET is_sold_out = false, is_available = true`);
});

function agentCtx(callerNumber?: string) {
  return {
    db,
    restaurant: ctx.restaurant,
    settings: ctx.settings,
    hours: ctx.hours,
    callerNumber,
    now: () => new Date("2026-09-10T19:00:00+08:00"),
  };
}

async function readyDraft() {
  const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "T" });
  const item = await findItemByName(db, "Chicken Meatbox");
  const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
  await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1, modifierIds: [base] });
  return draft;
}

describe("gap-closing: pause switch", () => {
  it("paused ordering blocks confirmation server-side", async () => {
    const draft = await readyDraft();
    await db.query(
      `UPDATE restaurant_settings SET accepting_orders = false, pause_reason = 'kitchen at capacity'`,
    );
    await expect(
      confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" }),
    ).rejects.toThrow(/not taking orders.*kitchen at capacity/);
  });

  it("paused ordering blocks new drafts through the agent", async () => {
    const paused = { ...ctx.settings, acceptingOrders: false, pauseReason: "closing early" };
    const llm = new FakeLlm([
      toolTurn("create_order_draft", {}, "tu_1"),
      textTurn("Sorry, we're not taking orders right now — we're closing early tonight."),
    ]);
    const agent = new OrderAgent(llm, { ...agentCtx("+61400000001"), settings: paused });
    const turn = await agent.handleTurn("one chicken kebab please");
    expect(String(turn.toolCalls[0]!.result.error)).toMatch(/paused.*closing early/);
  });
});

describe("gap-closing: availability recheck at commitment", () => {
  it("an item that sells out mid-call is refused at confirm", async () => {
    const draft = await readyDraft();
    await db.query(`UPDATE menu_items SET is_sold_out = true WHERE name = 'Chicken Meatbox'`);
    await expect(
      confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" }),
    ).rejects.toThrow(/Chicken Meatbox just sold out/);
    // Order remains a draft — never silently accepted.
    const status = await db.query(`SELECT status FROM orders WHERE id = $1`, [draft.id]);
    expect((status.rows[0] as { status: string }).status).toBe("draft");
  });
});

describe("gap-closing: menu link + order status tools", () => {
  it("send_menu_link queues an SMS to the caller's own number only", async () => {
    const llm = new FakeLlm([
      toolTurn("send_menu_link", {}, "tu_1"),
      textTurn("A text with the menu is on its way."),
    ]);
    const agent = new OrderAgent(llm, agentCtx("+61400000123"));
    const turn = await agent.handleTurn("can you text me the menu?");
    expect(turn.toolCalls[0]!.result.ok).toBe(true);
    const sms = await db.query(
      `SELECT to_number, body FROM notification_attempts WHERE kind = 'customer_sms'`,
    );
    expect((sms.rows[0] as { to_number: string }).to_number).toBe("+61400000123");
    expect((sms.rows[0] as { body: string }).body).toMatch(/menu/i);
  });

  it("get_current_order_status reports the caller's latest order, never 'ready' early", async () => {
    const draft = await createDraft(db, {
      restaurantId: ctx.restaurant.id,
      customerName: "Statusy",
      customerPhone: "+61400000456",
    });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    const { confirmOrderWithNotifications } = await import("../src/domain/flow");
    await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
    });

    const llm = new FakeLlm([
      toolTurn("get_current_order_status", {}, "tu_1"),
      textTurn("It's in the kitchen — about ten minutes away."),
    ]);
    const agent = new OrderAgent(llm, agentCtx("+61400000456"));
    const turn = await agent.handleTurn("how far away is my order?");
    const result = turn.toolCalls[0]!.result;
    expect(result.found).toBe(true);
    expect(result.status).toBe("new");
    expect(String(result.readyEstimate)).toMatch(/about/);
    expect(String(result.readyEstimate)).not.toMatch(/ready for collection now/);
  });
});

describe("gap-closing: queue re-estimation", () => {
  it("recalculates queued estimates without touching first promises", async () => {
    const item = await findItemByName(db, "Water");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: `Q${i}` });
      await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
      const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
      await db.query(
        `UPDATE orders SET first_promised_ready_at = now() + interval '30 minutes',
           current_estimated_ready_at = now() + interval '30 minutes' WHERE id = $1`,
        [order.id],
      );
      ids.push(order.id);
    }
    const updated = await recalcQueueEstimates(db, {
      restaurantId: ctx.restaurant.id,
      settings: {
        kitchenCapacity: 2,
        simpleBaselineSeconds: 600,
        complexBaselineSeconds: 1200,
        minPrepMinutes: 0,
      },
    });
    expect(updated).toBeGreaterThan(0);
    const rows = await db.query(
      `SELECT first_promised_ready_at, current_estimated_ready_at FROM orders WHERE id = ANY($1)`,
      [ids],
    );
    for (const r of rows.rows) {
      const row = r as { first_promised_ready_at: Date; current_estimated_ready_at: Date };
      // first promise untouched (still ~30 min out); current estimate moved earlier
      expect(row.first_promised_ready_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60000);
      expect(row.current_estimated_ready_at.getTime()).toBeLessThan(
        row.first_promised_ready_at.getTime(),
      );
    }
  });
});
