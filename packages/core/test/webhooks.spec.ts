import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { env } from "../src/env";
import { signWebhookBody, type WebhookSender } from "../src/domain/webhooks";
import { processPendingNotifications, type SmsSender } from "../src/domain/notifications";
import { addOrderItem, createDraft, markNeedsReview } from "../src/domain/orders";
import { confirmOrderWithNotifications } from "../src/domain/flow";
import {
  findItemByName,
  resetTransactionalData,
  setupTestDb,
  type TestContext,
} from "./helpers";

let ctx: TestContext;
let db: pg.Pool;
const savedUrl = env.N8N_WEBHOOK_URL;

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  (env as { N8N_WEBHOOK_URL: string }).N8N_WEBHOOK_URL = "https://n8n.test/webhook/meatbox-orders";
});

afterAll(async () => {
  (env as { N8N_WEBHOOK_URL: string }).N8N_WEBHOOK_URL = savedUrl;
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
});

const smsOk: SmsSender = { send: async () => ({ sid: "SM1" }) };

describe("n8n webhook events", () => {
  it("enqueues order.confirmed in the confirmation transaction and delivers it", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "Dana" });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 2 });
    const { order } = await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings: { ...ctx.settings, ownerSmsNumber: "+61455500001" },
    });

    const rows = await db.query(
      `SELECT to_number, body FROM notification_attempts WHERE kind = 'webhook'`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as { to_number: string; body: string };
    expect(row.to_number).toBe("https://n8n.test/webhook/meatbox-orders");
    const payload = JSON.parse(row.body) as Record<string, unknown>;
    expect(payload.event).toBe("order.confirmed");
    expect(payload.orderNumber).toBe(order.publicOrderNumber);
    expect(payload.total).toBe("$6.00");

    const delivered: { url: string; body: string }[] = [];
    const webhookSender: WebhookSender = {
      send: async (url, body) => {
        delivered.push({ url, body });
        return { sid: "WH-200" };
      },
    };
    await processPendingNotifications(db, smsOk, webhookSender);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.url).toBe("https://n8n.test/webhook/meatbox-orders");
    const status = await db.query(
      `SELECT status FROM notification_attempts WHERE kind = 'webhook'`,
    );
    expect((status.rows[0] as { status: string }).status).toBe("sent");
  });

  it("enqueues order.needs_review when a draft is flagged", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "Kim" });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    await markNeedsReview(db, draft.id, "call dropped");
    const rows = await db.query(`SELECT body FROM notification_attempts WHERE kind = 'webhook'`);
    expect(rows.rows).toHaveLength(1);
    const payload = JSON.parse((rows.rows[0] as { body: string }).body) as Record<string, unknown>;
    expect(payload.event).toBe("order.needs_review");
    expect(payload.customerName).toBe("Kim");
  });

  it("webhook retries do not touch SMS handling, and failures back off", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "A" });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    await confirmOrderWithNotifications(db, {
      orderId: draft.id,
      restaurant: ctx.restaurant,
      settings: { ...ctx.settings, ownerSmsNumber: "+61455500001" },
    });
    const failing: WebhookSender = {
      send: async () => {
        throw new Error("n8n unreachable");
      },
    };
    await processPendingNotifications(db, smsOk, failing);
    const rows = await db.query(
      `SELECT kind, status FROM notification_attempts ORDER BY kind`,
    );
    const byKind = Object.fromEntries(
      rows.rows.map((r) => [(r as { kind: string }).kind, (r as { status: string }).status]),
    );
    expect(byKind.owner_sms).toBe("sent");
    expect(byKind.webhook).toBe("failed"); // will retry with backoff
  });

  it("signs bodies with HMAC-SHA256", () => {
    const sig = signWebhookBody('{"event":"order.confirmed"}', "topsecret");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signWebhookBody('{"event":"order.confirmed"}', "topsecret"));
    expect(sig).not.toBe(signWebhookBody('{"event":"order.confirmed"}', "other"));
  });
});
