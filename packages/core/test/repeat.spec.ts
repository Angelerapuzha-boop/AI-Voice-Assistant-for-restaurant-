import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import { addOrderItem, createDraft } from "../src/domain/orders";
import { confirmOrderWithNotifications } from "../src/domain/flow";
import { findOrderByTrackingToken, getLastOrderForPhone } from "../src/domain/customers";
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
const PHONE = "+61400000777";

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
  await db.query(`DELETE FROM customers`);
});

async function placeConfirmedOrder(): Promise<string> {
  const draft = await createDraft(db, {
    restaurantId: ctx.restaurant.id,
    customerName: "Repeat Rita",
    customerPhone: PHONE,
    source: "phone",
  });
  const item = await findItemByName(db, "Chicken Meatbox");
  const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
  await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 2, modifierIds: [base] });
  const { order } = await confirmOrderWithNotifications(db, {
    orderId: draft.id,
    restaurant: ctx.restaurant,
    settings: { ...ctx.settings, ownerSmsNumber: "+61455500001", customerSmsEnabled: true },
  });
  return order.id;
}

describe("returning customers, ETA and tracking (master-prompt add-ons)", () => {
  it("confirmation links a customer, promises a ready time and issues a tracking token", async () => {
    await placeConfirmedOrder();
    const customer = await db.query(`SELECT * FROM customers WHERE phone_e164 = $1`, [PHONE]);
    expect(customer.rows).toHaveLength(1);
    expect((customer.rows[0] as { display_name: string }).display_name).toBe("Repeat Rita");

    const order = await db.query(
      `SELECT first_promised_ready_at, current_estimated_ready_at, tracking_token_hash, customer_id
       FROM orders WHERE status = 'new'`,
    );
    const row = order.rows[0] as Record<string, unknown>;
    expect(row.first_promised_ready_at).not.toBeNull();
    expect(row.tracking_token_hash).not.toBeNull();
    expect(row.customer_id).not.toBeNull();

    // Customer SMS carries the ready time, pay-on-collection and track link
    const sms = await db.query(
      `SELECT body FROM notification_attempts WHERE kind = 'customer_sms'`,
    );
    const body = (sms.rows[0] as { body: string }).body;
    expect(body).toMatch(/About /);
    expect(body).toMatch(/Pay on collection/);
    expect(body).toMatch(/\/track\//);

    // The tracking link in the SMS resolves to the order
    const token = /\/track\/([A-Za-z0-9_-]+)/.exec(body)![1]!;
    const tracked = await findOrderByTrackingToken(db, token);
    expect(tracked?.customerName).toBe("Repeat Rita");
    expect(await findOrderByTrackingToken(db, "forged-token")).toBeNull();
  });

  it("repeat lookup is scoped to the caller's number only", async () => {
    await placeConfirmedOrder();
    const mine = await getLastOrderForPhone(db, ctx.restaurant.id, PHONE);
    expect(mine?.order.items[0]?.nameSnapshot).toBe("Chicken Meatbox");
    expect(await getLastOrderForPhone(db, ctx.restaurant.id, "+61499999999")).toBeNull();
  });

  it("'same as last time' clones at current prices through the agent", async () => {
    await placeConfirmedOrder();
    // Price rise after the original order: the repeat must use the new price.
    await db.query(`UPDATE menu_items SET price_cents = 2195 WHERE name = 'Chicken Meatbox'`);

    const llm = new FakeLlm([
      toolTurn("get_repeat_candidate", {}, "tu_1"),
      toolTurn("repeat_last_order", {}, "tu_2"),
      textTurn("Two chicken meatboxes with chips and salad again — forty-three ninety, that right?"),
    ]);
    const agent = new OrderAgent(llm, {
      db,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
      callerNumber: PHONE,
      now: () => new Date("2026-09-10T19:00:00+08:00"),
    } satisfies AgentContext);

    const turn = await agent.handleTurn("same as last time thanks");
    const candidate = turn.toolCalls.find((c) => c.name === "get_repeat_candidate");
    expect(candidate!.result.found).toBe(true);
    const repeat = turn.toolCalls.find((c) => c.name === "repeat_last_order");
    expect(repeat!.result.repeatedLines).toBe(1);
    expect(repeat!.result.total).toBe("$43.90"); // 2 x current $21.95, not the old price
    await db.query(`UPDATE menu_items SET price_cents = 1995 WHERE name = 'Chicken Meatbox'`);
  });

  it("repeat with a sold-out item reports the change instead of failing", async () => {
    await placeConfirmedOrder();
    await db.query(`UPDATE menu_items SET is_sold_out = true WHERE name = 'Chicken Meatbox'`);
    const llm = new FakeLlm([
      toolTurn("repeat_last_order", {}, "tu_1"),
      textTurn("Sorry, the chicken meatbox is sold out today."),
    ]);
    const agent = new OrderAgent(llm, {
      db,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
      callerNumber: PHONE,
      now: () => new Date("2026-09-10T19:00:00+08:00"),
    });
    const turn = await agent.handleTurn("usual please");
    const repeat = turn.toolCalls.find((c) => c.name === "repeat_last_order");
    expect(repeat!.result.repeatedLines).toBe(0);
    expect((repeat!.result.changes as string[])[0]).toMatch(/not available/);
    await db.query(`UPDATE menu_items SET is_sold_out = false WHERE name = 'Chicken Meatbox'`);
  });

  it("callers without usable caller ID cannot access history", async () => {
    await placeConfirmedOrder();
    const llm = new FakeLlm([
      toolTurn("get_repeat_candidate", {}, "tu_1"),
      textTurn("I can't look that up on this line — what would you like?"),
    ]);
    const agent = new OrderAgent(llm, {
      db,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
      callerNumber: undefined,
      now: () => new Date("2026-09-10T19:00:00+08:00"),
    });
    const turn = await agent.handleTurn("gimme my usual");
    expect(turn.toolCalls[0]!.result.found).toBe(false);
  });
});
