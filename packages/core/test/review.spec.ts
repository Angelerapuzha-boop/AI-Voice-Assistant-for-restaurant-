import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { addOrderItem, confirmOrder, createDraft, getOrderWithItems } from "../src/domain/orders";
import {
  confirmByReviewToken,
  createReviewLink,
  expireStaleReviewDrafts,
  findOrderByReviewToken,
} from "../src/domain/review";
import { recalcQueueEstimates } from "../src/domain/eta";
import { executeTool, initialAgentState } from "../src/agent/tools";
import {
  findItemByName,
  modifierId,
  resetTransactionalData,
  setupTestDb,
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

const PHONE = "+61400000777";

async function reviewableDraft(name = "Vis") {
  const draft = await createDraft(db, {
    restaurantId: ctx.restaurant.id,
    customerName: name,
    customerPhone: PHONE,
  });
  const item = await findItemByName(db, "Chicken Meatbox");
  const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
  await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1, modifierIds: [base] });
  return (await getOrderWithItems(db, draft.id))!;
}

function tokenFromUrl(url: string): string {
  return url.split("/confirm/")[1]!;
}

describe("visual confirmation: review link", () => {
  it("freezes the draft behind a texted link; order never reaches the kitchen unconfirmed", async () => {
    const order = await reviewableDraft();
    const { url, expiresAt } = await createReviewLink(db, {
      order,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
    });
    expect(url).toMatch(/\/confirm\/[A-Za-z0-9_-]{16,}/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Review SMS queued with the spec's honesty line.
    const sms = await db.query(`SELECT to_number, body FROM notification_attempts WHERE kind = 'review_sms'`);
    expect(sms.rows).toHaveLength(1);
    expect((sms.rows[0] as { to_number: string }).to_number).toBe(PHONE);
    expect((sms.rows[0] as { body: string }).body).toMatch(/NOT reached the kitchen/);

    // Still a draft: invisible to every kitchen/active query.
    const fresh = await getOrderWithItems(db, order.id);
    expect(fresh!.status).toBe("draft");
    expect(fresh!.publicOrderNumber).toBeNull();
  });

  it("requires a name and a usable phone before a link can go out", async () => {
    const noName = await createDraft(db, { restaurantId: ctx.restaurant.id, customerPhone: PHONE });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: noName.id, menuItemId: item.id, quantity: 1 });
    await expect(
      createReviewLink(db, {
        order: (await getOrderWithItems(db, noName.id))!,
        restaurant: ctx.restaurant,
        settings: ctx.settings,
      }),
    ).rejects.toThrow(/name/i);
  });

  it("GET lookup never mutates; the explicit confirm commits exactly once (idempotent)", async () => {
    const order = await reviewableDraft();
    const { url } = await createReviewLink(db, {
      order,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
    });
    const token = tokenFromUrl(url);

    // "Viewing" repeatedly (link previews) changes nothing.
    for (let i = 0; i < 3; i++) {
      const lookup = await findOrderByReviewToken(db, token);
      expect(lookup!.order.status).toBe("draft");
      expect(lookup!.expired).toBe(false);
    }

    const first = await confirmByReviewToken(db, {
      token,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
    });
    expect(first.alreadyConfirmed).toBe(false);
    expect(first.order.status).toBe("new");
    expect(first.order.publicOrderNumber).toMatch(/^MB/);
    expect(first.trackUrl).toMatch(/\/track\//);

    // Duplicate tap: prior result, no second order/notification set.
    const again = await confirmByReviewToken(db, {
      token,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
    });
    expect(again.alreadyConfirmed).toBe(true);
    expect(again.order.id).toBe(first.order.id);

    const owner = await db.query(`SELECT count(*)::int AS n FROM notification_attempts WHERE kind = 'owner_sms'`);
    expect((owner.rows[0] as { n: number }).n).toBe(1);
  });

  it("an expired link can never commit, and the sweep cancels the stale draft", async () => {
    const order = await reviewableDraft();
    const { url } = await createReviewLink(db, {
      order,
      restaurant: ctx.restaurant,
      settings: ctx.settings,
    });
    const token = tokenFromUrl(url);
    await db.query(`UPDATE orders SET review_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      order.id,
    ]);

    const lookup = await findOrderByReviewToken(db, token);
    expect(lookup!.expired).toBe(true);
    await expect(
      confirmByReviewToken(db, { token, restaurant: ctx.restaurant, settings: ctx.settings, hours: ctx.hours }),
    ).rejects.toThrow(/expired/i);

    const swept = await expireStaleReviewDrafts(db);
    expect(swept).toBe(1);
    const status = await db.query(`SELECT status FROM orders WHERE id = $1`, [order.id]);
    expect((status.rows[0] as { status: string }).status).toBe("cancelled");
    // Sweeping again is a no-op.
    expect(await expireStaleReviewDrafts(db)).toBe(0);
    // A swept (cancelled) order is refused too — never "already confirmed".
    await expect(
      confirmByReviewToken(db, { token, restaurant: ctx.restaurant, settings: ctx.settings, hours: ctx.hours }),
    ).rejects.toThrow(/expired or was cancelled/);
  });

  it("a nonsense token resolves to nothing", async () => {
    expect(await findOrderByReviewToken(db, "not-a-real-token")).toBeNull();
    await expect(
      confirmByReviewToken(db, {
        token: "not-a-real-token",
        restaurant: ctx.restaurant,
        settings: ctx.settings,
        hours: ctx.hours,
      }),
    ).rejects.toThrow(/isn't valid/);
  });

  it("agent tool: send_review_link marks the call outcome and leaves the draft alive", async () => {
    const order = await reviewableDraft();
    const state = initialAgentState();
    state.draftOrderId = order.id;
    const result = await executeTool(
      {
        db,
        restaurant: ctx.restaurant,
        settings: { ...ctx.settings, customerSmsEnabled: true },
        hours: ctx.hours,
        callerNumber: PHONE,
        now: () => new Date(),
      },
      state,
      "send_review_link",
      {},
    );
    expect(result.ok).toBe(true);
    expect(String(result.note)).toMatch(/tap Confirm/);
    expect(state.reviewLinkSent).toBe(true);
    expect(state.outcome).toBe("REVIEW_LINK_SENT");
    const fresh = await getOrderWithItems(db, order.id);
    expect(fresh!.status).toBe("draft");
  });
});

describe("material-delay SMS", () => {
  async function confirmedPhoneOrder(name: string): Promise<string> {
    const draft = await createDraft(db, {
      restaurantId: ctx.restaurant.id,
      customerName: name,
      customerPhone: PHONE,
    });
    const item = await findItemByName(db, "Water");
    await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 });
    const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
    return order.id;
  }

  it("one throttled SMS when the estimate slips materially; no repeat without a further slip", async () => {
    // Four orders ahead on a single lane push the last order well past its promise.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await confirmedPhoneOrder(`D${i}`));
    const target = ids[ids.length - 1]!;
    // The customer was promised 10 minutes.
    await db.query(
      `UPDATE orders SET first_promised_ready_at = now() + interval '10 minutes',
         current_estimated_ready_at = now() + interval '10 minutes' WHERE id = $1`,
      [target],
    );

    const recalcParams = {
      restaurantId: ctx.restaurant.id,
      settings: {
        kitchenCapacity: 1,
        simpleBaselineSeconds: 600,
        complexBaselineSeconds: 1200,
        minPrepMinutes: 0,
      },
      delayNotify: {
        restaurant: ctx.restaurant,
        customerSmsEnabled: true,
        thresholdSeconds: 600,
      },
    };
    await recalcQueueEstimates(db, recalcParams);

    const delayed = await db.query(
      `SELECT order_id, body FROM notification_attempts WHERE kind = 'customer_sms' AND body LIKE '%running behind%'`,
    );
    expect(delayed.rows.length).toBeGreaterThanOrEqual(1);
    const targetSms = delayed.rows.filter((r) => (r as { order_id: string }).order_id === target);
    expect(targetSms).toHaveLength(1);
    expect((targetSms[0] as { body: string }).body).toMatch(/expected about/);

    // Same queue state again: cooldown — nothing new.
    await recalcQueueEstimates(db, recalcParams);
    const after = await db.query(
      `SELECT count(*)::int AS n FROM notification_attempts
       WHERE kind = 'customer_sms' AND body LIKE '%running behind%' AND order_id = $1`,
      [target],
    );
    expect((after.rows[0] as { n: number }).n).toBe(1);
  });

  it("stays silent while the slip is inside the threshold", async () => {
    const id = await confirmedPhoneOrder("Quiet");
    // Promise matches roughly what the queue will produce — no material slip.
    await db.query(
      `UPDATE orders SET first_promised_ready_at = now() + interval '30 minutes' WHERE id = $1`,
      [id],
    );
    await recalcQueueEstimates(db, {
      restaurantId: ctx.restaurant.id,
      settings: { kitchenCapacity: 3, simpleBaselineSeconds: 600, complexBaselineSeconds: 1200, minPrepMinutes: 0 },
      delayNotify: { restaurant: ctx.restaurant, customerSmsEnabled: true, thresholdSeconds: 600 },
    });
    const sms = await db.query(
      `SELECT count(*)::int AS n FROM notification_attempts WHERE kind = 'customer_sms' AND body LIKE '%running behind%'`,
    );
    expect((sms.rows[0] as { n: number }).n).toBe(0);
  });
});
