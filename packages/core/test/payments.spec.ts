import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { addOrderItem, confirmOrder, createDraft, getOrder, updateOrderStatus } from "../src/domain/orders";
import {
  completeOrderWithPayment,
  MockTerminalProvider,
  paymentSummaryForOrder,
  pollTerminalPayment,
  recordManualPayment,
  refundPayment,
  settlePayment,
  startTerminalPayment,
} from "../src/domain/payments";
import {
  collectionCode,
  kioskLookup,
  KioskLookupError,
  kioskSessionToken,
  normaliseOrderNumber,
  readyBoard,
  verifyKioskSessionToken,
} from "../src/domain/collection";
import { placePosOrder } from "../src/domain/flow";
import { findItemByName, resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

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

async function confirmedOrder(name = "Payer", phone = "+61400000888"): Promise<string> {
  const draft = await createDraft(db, {
    restaurantId: ctx.restaurant.id,
    customerName: name,
    customerPhone: phone,
  });
  const item = await findItemByName(db, "Water");
  await addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 2 });
  const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
  return order.id;
}

/** Backdate the mock terminal's embedded start time so a poll resolves now. */
async function backdateMockAttempt(paymentId: string): Promise<void> {
  await db.query(
    `UPDATE payments SET provider_payment_id =
       regexp_replace(provider_payment_id, '^mock_([a-z]+)_[0-9]+_', 'mock_\\1_' || ((extract(epoch from now())*1000)::bigint - 60000) || '_')
     WHERE id = $1`,
    [paymentId],
  );
}

describe("terminal payments (mock provider)", () => {
  it("one pending attempt per order; a second start resumes it", async () => {
    const orderId = await confirmedOrder();
    const first = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    expect(first.status).toBe("pending");
    expect(first.providerPaymentId).toMatch(/^mock_approve_/);
    const second = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    expect(second.id).toBe(first.id);
    const count = await db.query(`SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1`, [orderId]);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("stays pending while the terminal waits, settles paid once approved", async () => {
    const orderId = await confirmedOrder();
    const attempt = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    const early = await pollTerminalPayment(db, attempt.id);
    expect(early!.status).toBe("pending"); // terminal hasn't approved yet

    await backdateMockAttempt(attempt.id);
    const settled = await pollTerminalPayment(db, attempt.id);
    expect(settled!.status).toBe("succeeded");

    const order = await getOrder(db, orderId);
    expect(order!.paidAt).not.toBeNull();
    expect(order!.paymentMethod).toBe("card");
    const summary = await paymentSummaryForOrder(db, orderId, order!.totalCents);
    expect(summary.state).toBe("paid");
    expect(summary.outstandingCents).toBe(0);
  });

  it("settlement is idempotent — duplicate and out-of-order callbacks are no-ops", async () => {
    const orderId = await confirmedOrder();
    const attempt = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    await settlePayment(db, { paymentId: attempt.id, outcome: "succeeded" });
    // Late duplicate says "failed" — must not un-pay anything.
    const after = await settlePayment(db, { paymentId: attempt.id, outcome: "failed", failureReason: "late" });
    expect(after!.status).toBe("succeeded");
    const order = await getOrder(db, orderId);
    expect(order!.paidAt).not.toBeNull();
  });

  it("a declined terminal never marks the order paid; retry is allowed", async () => {
    const orderId = await confirmedOrder();
    const attempt = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    await settlePayment(db, { paymentId: attempt.id, outcome: "failed", failureReason: "DECLINED" });
    const order = await getOrder(db, orderId);
    expect(order!.paidAt).toBeNull();
    // The failed attempt frees the slot for a fresh one.
    const retry = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    expect(retry.id).not.toBe(attempt.id);
  });

  it("refuses drafts, cancelled and already-paid orders", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "D" });
    await expect(startTerminalPayment(db, { orderId: draft.id, actor: "kiosk" })).rejects.toThrow(
      /can't be paid/,
    );
    const orderId = await confirmedOrder();
    await recordManualPayment(db, { orderId, method: "cash", actor: "owner@test" });
    await expect(startTerminalPayment(db, { orderId, actor: "kiosk" })).rejects.toThrow(/already paid/);
  });
});

describe("manual payments and handover", () => {
  it("audited cash payment supersedes a dangling terminal attempt", async () => {
    const orderId = await confirmedOrder();
    const attempt = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    const cash = await recordManualPayment(db, { orderId, method: "cash", actor: "staff@meatbox" });
    expect(cash.status).toBe("succeeded");
    const dangling = await db.query(`SELECT status FROM payments WHERE id = $1`, [attempt.id]);
    expect((dangling.rows[0] as { status: string }).status).toBe("cancelled");
    const audit = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'payment.manual' AND entity_id = $1`,
      [cash.id],
    );
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it("handover of an unpaid order is refused without settlement or an owner exception", async () => {
    const orderId = await confirmedOrder();
    await updateOrderStatus(db, orderId, "ready", "kitchen@test");
    await expect(completeOrderWithPayment(db, { orderId, actor: "kitchen@test" })).rejects.toThrow(
      /hasn't been paid/,
    );
    const cash = await completeOrderWithPayment(db, {
      orderId,
      actor: "kitchen@test",
      settle: "cash",
    });
    expect(cash.status).toBe("completed");
    expect(cash.paidAt).not.toBeNull();
  });

  it("owner exception hands over unpaid — audited, never silently", async () => {
    const orderId = await confirmedOrder();
    await updateOrderStatus(db, orderId, "ready", "kitchen@test");
    const order = await completeOrderWithPayment(db, {
      orderId,
      actor: "owner@test",
      settle: "exception",
      exceptionReason: "regular, pays tomorrow",
    });
    expect(order.status).toBe("completed");
    expect(order.paidAt).toBeNull();
    const audit = await db.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE action = 'order.collected_unpaid_exception' AND entity_id = $1`,
      [orderId],
    );
    expect((audit.rows[0] as { n: number }).n).toBe(1);
  });

  it("POS orders write a reconciled ledger row", async () => {
    const item = await findItemByName(db, "Water");
    const order = await placePosOrder(db, {
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      actorEmail: "cashier@test",
      orderType: "takeaway",
      paymentMethod: "tap",
      items: [{ menuItemId: item.id, quantity: 1 }],
    });
    const summary = await paymentSummaryForOrder(db, order.id, order.totalCents);
    expect(summary.state).toBe("paid");
  });
});

describe("refunds", () => {
  it("partial refunds are capped at the payment amount", async () => {
    const orderId = await confirmedOrder();
    const payment = await recordManualPayment(db, { orderId, method: "cash", actor: "owner@test" });
    const refund = await refundPayment(db, {
      paymentId: payment.id,
      amountCents: 100,
      reason: "missing drink",
      actor: "owner@test",
    });
    expect(refund.status).toBe("succeeded");
    await expect(
      refundPayment(db, {
        paymentId: payment.id,
        amountCents: payment.amountCents, // would exceed with the earlier 100
        reason: "too much",
        actor: "owner@test",
      }),
    ).rejects.toThrow(/exceed/);
    const order = await getOrder(db, orderId);
    const summary = await paymentSummaryForOrder(db, orderId, order!.totalCents);
    expect(summary.state).toBe("partially_refunded");
    expect(summary.refundedCents).toBe(100);
  });

  it("only settled payments can be refunded", async () => {
    const orderId = await confirmedOrder();
    const attempt = await startTerminalPayment(db, { orderId, actor: "kiosk" });
    await expect(
      refundPayment(db, { paymentId: attempt.id, amountCents: 100, reason: "x", actor: "owner@test" }),
    ).rejects.toThrow(/settled/);
  });
});

describe("collection kiosk", () => {
  it("pickup codes are derived, 4 digits, and stable per order", async () => {
    const orderId = await confirmedOrder();
    const code = collectionCode(orderId);
    expect(code).toMatch(/^\d{4}$/);
    expect(collectionCode(orderId)).toBe(code);
  });

  it("normalises typed order numbers", () => {
    expect(normaliseOrderNumber(" 1015 ")).toBe("MB1015");
    expect(normaliseOrderNumber("mb-1015")).toBe("MB1015");
  });

  it("verified lookup succeeds; wrong code and unknown order fail IDENTICALLY", async () => {
    const orderId = await confirmedOrder("Kioski");
    const order = await getOrder(db, orderId);
    const good = await kioskLookup(db, {
      restaurantId: ctx.restaurant.id,
      orderNumber: order!.publicOrderNumber!,
      code: collectionCode(orderId),
      ip: "1.1.1.1",
    });
    expect(good.id).toBe(orderId);

    const wrongCode = collectionCode(orderId) === "0000" ? "0001" : "0000";
    let wrongCodeErr = "";
    let unknownErr = "";
    try {
      await kioskLookup(db, {
        restaurantId: ctx.restaurant.id,
        orderNumber: order!.publicOrderNumber!,
        code: wrongCode,
        ip: "1.1.1.2",
      });
    } catch (err) {
      wrongCodeErr = (err as Error).message;
      expect(err).toBeInstanceOf(KioskLookupError);
    }
    try {
      await kioskLookup(db, {
        restaurantId: ctx.restaurant.id,
        orderNumber: "MB999999",
        code: "1234",
        ip: "1.1.1.2",
      });
    } catch (err) {
      unknownErr = (err as Error).message;
    }
    // No enumeration signal: both failures read exactly the same.
    expect(wrongCodeErr).toBe(unknownErr);
    expect(wrongCodeErr).not.toBe("");
  });

  it("rate limits: five failures lock the order key even for the right code", async () => {
    const orderId = await confirmedOrder("Limity");
    const order = await getOrder(db, orderId);
    for (let i = 0; i < 5; i++) {
      await kioskLookup(db, {
        restaurantId: ctx.restaurant.id,
        orderNumber: order!.publicOrderNumber!,
        code: "9999" === collectionCode(orderId) ? "9998" : "9999",
        ip: `2.2.2.${i}`, // different IPs — the order key itself is what locks
      }).catch(() => undefined);
    }
    await expect(
      kioskLookup(db, {
        restaurantId: ctx.restaurant.id,
        orderNumber: order!.publicOrderNumber!,
        code: collectionCode(orderId),
        ip: "3.3.3.3",
      }),
    ).rejects.toThrow(KioskLookupError);
  });

  it("kiosk session tokens are scoped, tamper-proof and expiring", async () => {
    const token = kioskSessionToken("some-order-id", 60);
    expect(verifyKioskSessionToken(token)?.orderId).toBe("some-order-id");
    expect(verifyKioskSessionToken(token.slice(0, -2) + "xx")).toBeNull();
    const expired = kioskSessionToken("some-order-id", -1);
    expect(verifyKioskSessionToken(expired)).toBeNull();
  });

  it("ready board exposes order numbers only", async () => {
    const orderId = await confirmedOrder("Boardy");
    await updateOrderStatus(db, orderId, "preparing", "kitchen@test");
    await updateOrderStatus(db, orderId, "ready", "kitchen@test");
    const board = await readyBoard(db, ctx.restaurant.id);
    const order = await getOrder(db, orderId);
    expect(board.ready).toContain(order!.publicOrderNumber);
    expect(JSON.stringify(board)).not.toContain("Boardy");
    expect(JSON.stringify(board)).not.toContain("+61400000888");
  });
});
