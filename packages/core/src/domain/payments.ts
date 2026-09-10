import crypto from "node:crypto";
import type pg from "pg";
import { withTransaction, type Queryable } from "../db/client";
import { env } from "../env";
import { camelRow, camelRows, type Order, type Payment, type PaymentStatus, type Refund } from "../types";
import { auditLog } from "./audit";
import { getOrder, OrderValidationError, updateOrderStatus } from "./orders";
import { getSquareConnection, squareFetch, type SquareConnection } from "./square";

/**
 * Phase 3 payments (spec 14).
 *
 * The `payments` table is the reconciled ledger: only verified provider
 * settlement or an authorised, audited manual payment updates it — button
 * clicks, redirects and success animations are never payment evidence.
 * Terminal attempts are created in the DB first (pending, one per order),
 * then the provider is called OUTSIDE the transaction; settlement is
 * idempotent, so duplicate or out-of-order provider callbacks are safe.
 *
 * PaymentProvider matches the master prompt's interface; the spec's
 * createPaymentAttempt lives here as startTerminalPayment because attempt
 * rows are database work shared by every provider.
 */

export interface ProviderStatus {
  status: PaymentStatus;
  failureReason?: string;
  /** Provider's own payment object id (Square: payment id behind a checkout). */
  settlementId?: string;
}

export interface PaymentProvider {
  readonly name: "mock_terminal" | "square_terminal";
  /** Explicit test adapter — surfaced as a badge on every screen that uses it. */
  readonly isTest: boolean;
  initiateTerminalPayment(attempt: Payment, order: Order): Promise<{ providerPaymentId: string }>;
  getPaymentStatus(providerPaymentId: string): Promise<ProviderStatus>;
  cancelAttempt(providerPaymentId: string): Promise<void>;
  refundPayment(payment: Payment, amountCents: number, reason: string): Promise<{
    providerRefundId: string;
    status: "pending" | "succeeded";
  }>;
  verifyAndParseWebhook(params: {
    signature: string;
    rawBody: string;
    notificationUrl: string;
  }): {
    valid: boolean;
    events: { providerPaymentId: string; status: PaymentStatus; settlementId?: string }[];
  };
}

// ------------------------------------------------------------- mock adapter

/**
 * Deterministic EFTPOS terminal simulation for development and UAT. The
 * "terminal" approves or declines a fixed number of seconds after the
 * attempt starts (state carried in the provider id, like a real external
 * system's reference — no hidden shortcuts through our own database).
 */
export class MockTerminalProvider implements PaymentProvider {
  readonly name = "mock_terminal" as const;
  readonly isTest = true;
  constructor(
    private readonly opts: {
      behaviour: "approve" | "decline";
      delaySeconds: number;
      now?: () => Date;
    },
  ) {}

  private now(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  async initiateTerminalPayment(attempt: Payment): Promise<{ providerPaymentId: string }> {
    const rand = crypto.randomBytes(4).toString("hex");
    return {
      providerPaymentId: `mock_${this.opts.behaviour}_${this.now()}_${attempt.id.slice(0, 8)}_${rand}`,
    };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderStatus> {
    const [, behaviour, startedMs] = providerPaymentId.split("_");
    const started = Number(startedMs);
    if (!Number.isFinite(started)) return { status: "failed", failureReason: "unknown attempt" };
    if (this.now() - started < this.opts.delaySeconds * 1000) return { status: "pending" };
    return behaviour === "approve"
      ? { status: "succeeded", settlementId: providerPaymentId }
      : { status: "failed", failureReason: "DECLINED (test terminal)" };
  }

  async cancelAttempt(): Promise<void> {
    // The simulated terminal simply stops waiting.
  }

  async refundPayment(): Promise<{ providerRefundId: string; status: "succeeded" }> {
    return { providerRefundId: `mockrefund_${crypto.randomBytes(6).toString("hex")}`, status: "succeeded" };
  }

  verifyAndParseWebhook(): { valid: boolean; events: [] } {
    return { valid: false, events: [] }; // the mock terminal never calls back
  }
}

// ------------------------------------------------------------ Square adapter

/** Square Terminal checkouts (AU-supported). Requires OAuth connection + paired device. */
export class SquareTerminalProvider implements PaymentProvider {
  readonly name = "square_terminal" as const;
  readonly isTest = false;
  constructor(
    private readonly conn: SquareConnection,
    private readonly deviceId: string,
  ) {}

  async initiateTerminalPayment(attempt: Payment, order: Order): Promise<{ providerPaymentId: string }> {
    const res = await squareFetch(this.conn.environment, this.conn.accessToken, "/v2/terminals/checkouts", {
      method: "POST",
      body: {
        idempotency_key: attempt.idempotencyKey,
        checkout: {
          amount_money: { amount: attempt.amountCents, currency: attempt.currency },
          device_options: { device_id: this.deviceId, skip_receipt_screen: false },
          reference_id: order.publicOrderNumber ?? order.id.slice(0, 8),
          note: `Meat Box order ${order.publicOrderNumber ?? ""}`.trim(),
        },
      },
    });
    const checkout = res.checkout as { id?: string } | undefined;
    if (!checkout?.id) throw new Error("Square returned no checkout id");
    return { providerPaymentId: checkout.id };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderStatus> {
    const res = await squareFetch(
      this.conn.environment,
      this.conn.accessToken,
      `/v2/terminals/checkouts/${providerPaymentId}`,
    );
    const checkout = res.checkout as
      | { status?: string; payment_ids?: string[]; cancel_reason?: string }
      | undefined;
    switch (checkout?.status) {
      case "COMPLETED":
        return { status: "succeeded", settlementId: checkout.payment_ids?.[0] };
      case "CANCELED":
        return { status: "cancelled", failureReason: checkout.cancel_reason ?? "cancelled" };
      case "CANCEL_REQUESTED":
      case "PENDING":
      case "IN_PROGRESS":
      default:
        return { status: "pending" };
    }
  }

  async cancelAttempt(providerPaymentId: string): Promise<void> {
    await squareFetch(
      this.conn.environment,
      this.conn.accessToken,
      `/v2/terminals/checkouts/${providerPaymentId}/cancel`,
      { method: "POST" },
    );
  }

  async refundPayment(payment: Payment, amountCents: number, reason: string) {
    // The checkout's settled Square payment id was stored at settlement time
    // (settlementId → provider_payment_id suffix "|<paymentId>").
    const squarePaymentId = payment.providerPaymentId?.split("|")[1];
    if (!squarePaymentId) throw new Error("No settled Square payment id recorded for this payment");
    const res = await squareFetch(this.conn.environment, this.conn.accessToken, "/v2/refunds", {
      method: "POST",
      body: {
        idempotency_key: `refund-${payment.id}-${amountCents}`,
        payment_id: squarePaymentId,
        amount_money: { amount: amountCents, currency: payment.currency },
        reason: reason.slice(0, 190),
      },
    });
    const refund = res.refund as { id?: string; status?: string } | undefined;
    if (!refund?.id) throw new Error("Square returned no refund id");
    return {
      providerRefundId: refund.id,
      status: refund.status === "COMPLETED" ? ("succeeded" as const) : ("pending" as const),
    };
  }

  verifyAndParseWebhook(params: { signature: string; rawBody: string; notificationUrl: string }) {
    const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    if (!key) return { valid: false, events: [] };
    const expected = crypto
      .createHmac("sha256", key)
      .update(params.notificationUrl + params.rawBody)
      .digest("base64");
    const valid =
      params.signature.length > 0 &&
      expected.length === params.signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
    if (!valid) return { valid: false, events: [] };
    const events: { providerPaymentId: string; status: PaymentStatus; settlementId?: string }[] = [];
    try {
      const body = JSON.parse(params.rawBody) as {
        type?: string;
        data?: { object?: { checkout?: { id?: string; status?: string; payment_ids?: string[] } } };
      };
      const checkout = body.data?.object?.checkout;
      if (body.type?.startsWith("terminal.checkout") && checkout?.id) {
        const status: PaymentStatus =
          checkout.status === "COMPLETED"
            ? "succeeded"
            : checkout.status === "CANCELED"
              ? "cancelled"
              : "pending";
        events.push({ providerPaymentId: checkout.id, status, settlementId: checkout.payment_ids?.[0] });
      }
    } catch {
      // malformed body: verified but unusable — ignore
    }
    return { valid: true, events };
  }
}

export async function createPaymentProvider(
  db: Queryable,
  restaurantId: string,
): Promise<PaymentProvider> {
  if (env.PAYMENTS_PROVIDER === "square_terminal") {
    const conn = await getSquareConnection(db, restaurantId);
    if (!conn) {
      throw new OrderValidationError(
        "TERMINAL_UNAVAILABLE",
        "Square isn't connected yet — pay at the counter.",
      );
    }
    if (!env.SQUARE_TERMINAL_DEVICE_ID) {
      throw new OrderValidationError(
        "TERMINAL_UNAVAILABLE",
        "No Square Terminal device is paired — pay at the counter.",
      );
    }
    return new SquareTerminalProvider(conn, env.SQUARE_TERMINAL_DEVICE_ID);
  }
  return new MockTerminalProvider({
    behaviour: env.MOCK_TERMINAL_BEHAVIOUR,
    delaySeconds: env.MOCK_TERMINAL_DELAY_SECONDS,
  });
}

// ------------------------------------------------------------------ ledger

export async function getPayment(db: Queryable, paymentId: string): Promise<Payment | null> {
  const res = await db.query(`SELECT * FROM payments WHERE id = $1`, [paymentId]);
  return res.rows[0] ? camelRow<Payment>(res.rows[0]) : null;
}

export async function listPaymentsForOrder(db: Queryable, orderId: string): Promise<Payment[]> {
  const res = await db.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  return camelRows<Payment>(res.rows);
}

export interface PaymentSummary {
  paidCents: number;
  refundedCents: number;
  outstandingCents: number;
  state: "unpaid" | "paid" | "partially_refunded" | "refunded" | "pending";
}

/** Derived from the reconciled ledger, never from a boolean on the order. */
export async function paymentSummaryForOrder(
  db: Queryable,
  orderId: string,
  totalCents: number,
): Promise<PaymentSummary> {
  const res = await db.query(
    `SELECT
       COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'succeeded'), 0)::int AS paid,
       COALESCE((SELECT SUM(r.amount_cents) FROM refunds r
                 JOIN payments p2 ON p2.id = r.payment_id
                 WHERE p2.order_id = $1 AND r.status IN ('pending', 'succeeded')), 0)::int AS refunded,
       COUNT(*) FILTER (WHERE p.status = 'pending')::int AS pending
     FROM payments p WHERE p.order_id = $1`,
    [orderId],
  );
  const row = res.rows[0] as { paid: number; refunded: number; pending: number };
  const net = row.paid - row.refunded;
  const state: PaymentSummary["state"] =
    row.paid === 0
      ? row.pending > 0
        ? "pending"
        : "unpaid"
      : row.refunded === 0
        ? "paid"
        : net > 0
          ? "partially_refunded"
          : "refunded";
  return {
    paidCents: row.paid,
    refundedCents: row.refunded,
    outstandingCents: Math.max(0, totalCents - net),
    state,
  };
}

/**
 * Start (or resume) a terminal payment attempt for an order's outstanding
 * balance. Creating the pending row and calling the terminal are separate
 * steps — no provider network call inside a transaction. A second call while
 * an attempt is pending returns that attempt (double-tap safe).
 */
export async function startTerminalPayment(
  db: pg.Pool,
  params: { orderId: string; actor: string },
): Promise<Payment> {
  const created = await withTransaction(db, async (tx) => {
    const lock = await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (!lock.rows[0]) throw new OrderValidationError("ORDER_NOT_FOUND", "That order no longer exists.");
    const order = camelRow<Order>(lock.rows[0]);
    if (order.status === "cancelled" || order.status === "draft") {
      throw new OrderValidationError("ORDER_NOT_PAYABLE", "This order can't be paid.");
    }
    if (order.paidAt) {
      throw new OrderValidationError("ALREADY_PAID", "This order is already paid.");
    }
    const existing = await tx.query(
      `SELECT * FROM payments WHERE order_id = $1 AND status = 'pending'`,
      [params.orderId],
    );
    if (existing.rows[0]) return camelRow<Payment>(existing.rows[0]);
    const attemptNo = await tx.query(
      `SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1`,
      [params.orderId],
    );
    const res = await tx.query(
      `INSERT INTO payments (restaurant_id, order_id, provider, method, amount_cents, currency,
                             idempotency_key, authorised_by)
       VALUES ($1, $2, $3, 'terminal', $4, 'AUD', $5, $6) RETURNING *`,
      [
        order.restaurantId,
        order.id,
        env.PAYMENTS_PROVIDER,
        order.totalCents,
        `term-${order.id}-${(attemptNo.rows[0] as { n: number }).n + 1}`,
        params.actor,
      ],
    );
    return camelRow<Payment>(res.rows[0]);
  });

  if (created.providerPaymentId) return created; // resumed pending attempt

  const order = (await getOrder(db, params.orderId))!;
  const provider = await createPaymentProvider(db, order.restaurantId);
  try {
    const { providerPaymentId } = await provider.initiateTerminalPayment(created, order);
    const res = await db.query(
      `UPDATE payments SET provider_payment_id = $2, updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [created.id, providerPaymentId],
    );
    return res.rows[0] ? camelRow<Payment>(res.rows[0]) : created;
  } catch (err) {
    await db.query(
      `UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [created.id, String((err as Error).message).slice(0, 300)],
    );
    throw new OrderValidationError(
      "TERMINAL_UNAVAILABLE",
      "The payment terminal couldn't start — pay at the counter.",
    );
  }
}

/**
 * Idempotent settlement: only a pending attempt can move to a terminal
 * state, so duplicate and out-of-order provider callbacks are no-ops.
 * Success stamps the order paid inside the same transaction.
 */
export async function settlePayment(
  db: pg.Pool,
  params: {
    paymentId?: string;
    providerPaymentId?: string;
    outcome: Exclude<PaymentStatus, "pending">;
    failureReason?: string;
    settlementId?: string;
  },
): Promise<Payment | null> {
  return withTransaction(db, async (tx) => {
    const res = params.paymentId
      ? await tx.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [params.paymentId])
      : await tx.query(
          `SELECT * FROM payments WHERE split_part(provider_payment_id, '|', 1) = $1 FOR UPDATE`,
          [params.providerPaymentId],
        );
    if (!res.rows[0]) return null;
    const payment = camelRow<Payment>(res.rows[0]);
    if (payment.status !== "pending") return payment; // already settled — idempotent

    const providerId =
      params.outcome === "succeeded" && params.settlementId && payment.providerPaymentId
        ? `${payment.providerPaymentId}|${params.settlementId}`
        : payment.providerPaymentId;
    const updated = await tx.query(
      `UPDATE payments SET status = $2, failure_reason = $3, provider_payment_id = $4,
         settled_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE settled_at END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [payment.id, params.outcome, params.failureReason ?? "", providerId],
    );
    if (params.outcome === "succeeded") {
      await tx.query(
        `UPDATE orders SET paid_at = COALESCE(paid_at, now()),
           payment_method = CASE WHEN payment_method = '' THEN 'card' ELSE payment_method END,
           updated_at = now()
         WHERE id = $1`,
        [payment.orderId],
      );
    }
    await auditLog(tx, {
      restaurantId: payment.restaurantId,
      actor: "system",
      action: `payment.${params.outcome}`,
      entityType: "payment",
      entityId: payment.id,
      changes: { orderId: payment.orderId, amountCents: payment.amountCents },
    });
    return camelRow<Payment>(updated.rows[0]);
  });
}

/** Poll the provider for a pending attempt and settle when it resolves. */
export async function pollTerminalPayment(db: pg.Pool, paymentId: string): Promise<Payment | null> {
  const payment = await getPayment(db, paymentId);
  if (!payment) return null;
  if (payment.status !== "pending" || !payment.providerPaymentId) return payment;
  const order = await getOrder(db, payment.orderId);
  if (!order) return payment;
  const provider = await createPaymentProvider(db, payment.restaurantId);
  const status = await provider.getPaymentStatus(payment.providerPaymentId);
  if (status.status === "pending") return payment;
  return settlePayment(db, {
    paymentId: payment.id,
    outcome: status.status,
    failureReason: status.failureReason,
    settlementId: status.settlementId,
  });
}

export async function cancelTerminalPayment(
  db: pg.Pool,
  params: { paymentId: string; actor: string },
): Promise<Payment | null> {
  const payment = await getPayment(db, params.paymentId);
  if (!payment || payment.status !== "pending") return payment;
  if (payment.providerPaymentId) {
    const provider = await createPaymentProvider(db, payment.restaurantId);
    try {
      await provider.cancelAttempt(payment.providerPaymentId);
    } catch {
      // If the provider refuses (e.g. mid-capture), reconciliation decides.
    }
  }
  return settlePayment(db, {
    paymentId: params.paymentId,
    outcome: "cancelled",
    failureReason: `cancelled by ${params.actor}`,
  });
}

/** Audited manual payment (cash, or a card taken on the shop's own EFTPOS). */
export async function recordManualPayment(
  db: pg.Pool,
  params: { orderId: string; method: "cash" | "card" | "tap"; actor: string },
): Promise<Payment> {
  return withTransaction(db, async (tx) => {
    const lock = await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [params.orderId]);
    if (!lock.rows[0]) throw new OrderValidationError("ORDER_NOT_FOUND", "That order no longer exists.");
    const order = camelRow<Order>(lock.rows[0]);
    if (order.paidAt) throw new OrderValidationError("ALREADY_PAID", "This order is already paid.");
    // Supersede any dangling terminal attempt.
    await tx.query(
      `UPDATE payments SET status = 'cancelled', failure_reason = 'superseded by manual payment',
         updated_at = now() WHERE order_id = $1 AND status = 'pending'`,
      [params.orderId],
    );
    const res = await tx.query(
      `INSERT INTO payments (restaurant_id, order_id, provider, method, amount_cents, currency,
                             status, idempotency_key, authorised_by, settled_at)
       VALUES ($1, $2, 'manual', $3, $4, 'AUD', 'succeeded', $5, $6, now()) RETURNING *`,
      [
        order.restaurantId,
        order.id,
        params.method,
        order.totalCents,
        `manual-${order.id}-${Date.now()}`,
        params.actor,
      ],
    );
    await tx.query(
      `UPDATE orders SET paid_at = now(), payment_method = $2, updated_at = now() WHERE id = $1`,
      [order.id, params.method],
    );
    await auditLog(tx, {
      restaurantId: order.restaurantId,
      actor: params.actor,
      action: "payment.manual",
      entityType: "payment",
      entityId: (res.rows[0] as { id: string }).id,
      changes: { orderId: order.id, method: params.method, amountCents: order.totalCents },
    });
    return camelRow<Payment>(res.rows[0]);
  });
}

/**
 * Handover (spec 14): COLLECTED requires payment, an audited cash/card
 * settlement at handover, or an explicit owner-authorised exception. The
 * kiosk can never call this — payment success alone never collects.
 */
export async function completeOrderWithPayment(
  db: pg.Pool,
  params: {
    orderId: string;
    actor: string;
    settle?: "cash" | "card" | "tap" | "exception";
    exceptionReason?: string;
  },
): Promise<Order> {
  const order = await getOrder(db, params.orderId);
  if (!order) throw new OrderValidationError("ORDER_NOT_FOUND", "Order not found.");
  if (!order.paidAt) {
    if (!params.settle) {
      throw new OrderValidationError(
        "PAYMENT_REQUIRED",
        "This order hasn't been paid. Take payment (cash/card) or record an owner-authorised exception.",
      );
    }
    if (params.settle === "exception") {
      await auditLog(db, {
        restaurantId: order.restaurantId,
        actor: params.actor,
        action: "order.collected_unpaid_exception",
        entityType: "order",
        entityId: order.id,
        changes: { reason: params.exceptionReason ?? "", totalCents: order.totalCents },
      });
      await db.query(
        `UPDATE orders SET internal_notes = internal_notes
           || CASE WHEN internal_notes = '' THEN '' ELSE E'\n' END
           || 'Handed over UNPAID (owner exception by ' || $2 || ')' WHERE id = $1`,
        [order.id, params.actor],
      );
    } else {
      await recordManualPayment(db, { orderId: order.id, method: params.settle, actor: params.actor });
    }
  }
  return updateOrderStatus(db, params.orderId, "completed", params.actor);
}

// ------------------------------------------------------------------ refunds

export async function refundPayment(
  db: pg.Pool,
  params: { paymentId: string; amountCents: number; reason: string; actor: string },
): Promise<Refund> {
  const payment = await getPayment(db, params.paymentId);
  if (!payment) throw new OrderValidationError("PAYMENT_NOT_FOUND", "Payment not found.");
  if (payment.status !== "succeeded") {
    throw new OrderValidationError("NOT_REFUNDABLE", "Only a settled payment can be refunded.");
  }
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new OrderValidationError("BAD_AMOUNT", "Refund amount must be a positive whole number of cents.");
  }
  const already = await db.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM refunds
     WHERE payment_id = $1 AND status IN ('pending', 'succeeded')`,
    [params.paymentId],
  );
  if ((already.rows[0] as { n: number }).n + params.amountCents > payment.amountCents) {
    throw new OrderValidationError("REFUND_EXCEEDS", "Refunds can't exceed the payment amount.");
  }

  let providerRefundId = "";
  let status: "pending" | "succeeded" = "succeeded";
  if (payment.provider !== "manual") {
    const provider = await createPaymentProvider(db, payment.restaurantId);
    const result = await provider.refundPayment(payment, params.amountCents, params.reason);
    providerRefundId = result.providerRefundId;
    status = result.status;
  }
  const res = await db.query(
    `INSERT INTO refunds (restaurant_id, payment_id, provider_refund_id, amount_cents, status,
                          reason, created_by, settled_at)
     VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, CASE WHEN $5 = 'succeeded' THEN now() END)
     RETURNING *`,
    [
      payment.restaurantId,
      payment.id,
      providerRefundId,
      params.amountCents,
      status,
      params.reason,
      params.actor,
    ],
  );
  await auditLog(db, {
    restaurantId: payment.restaurantId,
    actor: params.actor,
    action: "payment.refund",
    entityType: "payment",
    entityId: payment.id,
    changes: { amountCents: params.amountCents, reason: params.reason },
  });
  return camelRow<Refund>(res.rows[0]);
}

export async function listRecentPayments(
  db: Queryable,
  restaurantId: string,
  limit = 100,
): Promise<(Payment & { orderNumber: string | null; customerName: string; refunds: Refund[] })[]> {
  const res = await db.query(
    `SELECT p.*, o.public_order_number AS order_number, o.customer_name
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.restaurant_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
    [restaurantId, limit],
  );
  const payments = camelRows<Payment & { orderNumber: string | null; customerName: string }>(res.rows);
  const refundsRes = await db.query(
    `SELECT * FROM refunds WHERE payment_id = ANY($1) ORDER BY created_at`,
    [payments.map((p) => p.id)],
  );
  const refunds = camelRows<Refund>(refundsRes.rows);
  return payments.map((p) => ({ ...p, refunds: refunds.filter((r) => r.paymentId === p.id) }));
}
