import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  customerSmsBody,
  enqueueNotification,
  getNotification,
  ownerSmsBody,
  processPendingNotifications,
  type SmsSender,
} from "../src/domain/notifications";
import { addOrderItem, confirmOrder, createDraft, getOrderWithItems } from "../src/domain/orders";
import { confirmOrderWithNotifications } from "../src/domain/flow";
import {
  findItemByName,
  modifierId,
  resetTransactionalData,
  setupTestDb,
  type TestContext,
} from "./helpers";

let ctx: TestContext;
let db: pg.Pool;
let savedWebhookUrl = "";

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  // This spec asserts exact SMS enqueue behaviour — keep n8n webhooks out.
  const { env } = await import("../src/env");
  savedWebhookUrl = env.N8N_WEBHOOK_URL;
  (env as { N8N_WEBHOOK_URL: string }).N8N_WEBHOOK_URL = "";
});

afterAll(async () => {
  const { env } = await import("../src/env");
  (env as { N8N_WEBHOOK_URL: string }).N8N_WEBHOOK_URL = savedWebhookUrl;
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
});

async function confirmedOrder() {
  const draft = await createDraft(db, {
    restaurantId: ctx.restaurant.id,
    customerName: "Daniel",
    customerPhone: "+61400000001",
  });
  const item = await findItemByName(db, "Chicken Meatbox");
  const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
  const extra = await modifierId(db, "Chicken Meatbox", "Extra meat");
  await addOrderItem(db, {
    orderId: draft.id,
    menuItemId: item.id,
    quantity: 2,
    modifierIds: [base, extra],
    removals: ["onion"],
  });
  const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
  return order;
}

describe("SMS bodies", () => {
  it("owner SMS is kitchen-readable", async () => {
    const order = await confirmedOrder();
    const body = ownerSmsBody(order, ctx.restaurant, "http://127.0.0.1:4810");
    expect(body).toContain(`NEW ORDER #${order.publicOrderNumber}`);
    expect(body).toContain("TAKEAWAY");
    expect(body).toContain("Name: Daniel");
    expect(body).toContain("2 x Chicken Meatbox");
    expect(body).toContain("- Extra meat (+$5.00)");
    expect(body).toContain("- No onion");
    expect(body).toContain("TOTAL: $49.90");
    expect(body).toContain("Pickup: ASAP");
  });

  it("customer SMS is short and friendly", async () => {
    const order = await confirmedOrder();
    const body = customerSmsBody(order, ctx.restaurant);
    expect(body).toContain("Daniel");
    expect(body).toContain(order.publicOrderNumber!);
    expect(body).toContain("$49.90");
  });
});

describe("outbox with retries (scenario 8)", () => {
  it("marks sent on success", async () => {
    const order = await confirmedOrder();
    const id = await enqueueNotification(db, {
      orderId: order.id,
      kind: "owner_sms",
      toNumber: "+61411111111",
      body: "test",
    });
    const sender: SmsSender = { send: async () => ({ sid: "SM123" }) };
    await processPendingNotifications(db, sender);
    const attempt = await getNotification(db, id);
    expect(attempt!.status).toBe("sent");
    expect(attempt!.providerSid).toBe("SM123");
  });

  it("keeps the order and flags the dashboard when the SMS keeps failing", async () => {
    const order = await confirmedOrder();
    const id = await enqueueNotification(db, {
      orderId: order.id,
      kind: "owner_sms",
      toNumber: "+61411111111",
      body: "test",
    });
    const sender: SmsSender = {
      send: async () => {
        throw new Error("provider down");
      },
    };
    // Exhaust all retries (force next_attempt_at into the past each round)
    for (let i = 0; i < 6; i++) {
      await processPendingNotifications(db, sender);
      await db.query(`UPDATE notification_attempts SET next_attempt_at = now() WHERE id = $1`, [id]);
    }
    const attempt = await getNotification(db, id);
    expect(attempt!.status).toBe("gave_up");
    expect(attempt!.attempts).toBe(6);
    // The confirmed order is untouched and now carries a visible alert.
    const stored = await getOrderWithItems(db, order.id);
    expect(stored!.status).toBe("new");
    expect(stored!.ownerSmsAlert).toBe(true);
  });

  it("applies backoff between attempts", async () => {
    const order = await confirmedOrder();
    const id = await enqueueNotification(db, {
      orderId: order.id,
      kind: "owner_sms",
      toNumber: "+61411111111",
      body: "test",
    });
    const sender: SmsSender = {
      send: async () => {
        throw new Error("boom");
      },
    };
    await processPendingNotifications(db, sender);
    const attempt = await getNotification(db, id);
    expect(attempt!.status).toBe("failed");
    expect(attempt!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 5000);
  });
});

describe("confirmOrderWithNotifications", () => {
  it("enqueues the owner SMS in the same transaction as confirmation", async () => {
    const draft = await createDraft(db, {
      restaurantId: ctx.restaurant.id,
      customerName: "Alex",
    });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    const { order } = await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings: { ...ctx.settings, ownerSmsNumber: "+61455500001", customerSmsEnabled: false },
    });
    const rows = await db.query(`SELECT kind FROM notification_attempts WHERE order_id = $1`, [
      order.id,
    ]);
    expect(rows.rows.map((r) => (r as { kind: string }).kind)).toEqual(["owner_sms"]);
  });

  it("does not enqueue a second owner SMS on duplicate confirm", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "A" });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    const settings = { ...ctx.settings, ownerSmsNumber: "+61455500001" };
    await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings,
    });
    await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings,
    });
    const rows = await db.query(
      `SELECT COUNT(*)::int AS n FROM notification_attempts WHERE kind = 'owner_sms'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });
});
