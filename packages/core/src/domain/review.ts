import crypto from "node:crypto";
import type pg from "pg";
import type { Queryable } from "../db/client";
import { env } from "../env";
import type { OrderWithItems, Restaurant, RestaurantHoursRow, RestaurantSettings } from "../types";
import { getOrderWithItems, OrderValidationError } from "./orders";
import { confirmOrderWithNotifications } from "./flow";
import { enqueueNotification } from "./notifications";
import { isUsablePhone } from "./customers";
import { openStateAt } from "./hours";
import { auditLog } from "./audit";

/**
 * Visual confirmation path (spec 4, VISUAL): freeze the draft behind a
 * single-use review link, text it to the caller, and commit ONLY on the
 * customer's explicit POST. Viewing the page (GET, SMS link previews)
 * never creates or confirms anything, and the order stays a draft —
 * which structurally never reaches the kitchen — until confirmed.
 */

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function reviewSmsBody(restaurantName: string, url: string): string {
  return `${restaurantName}: check and confirm your order: ${url} — it has NOT reached the kitchen yet.`;
}

export async function createReviewLink(
  db: Queryable,
  params: { order: OrderWithItems; restaurant: Restaurant; settings: RestaurantSettings },
): Promise<{ url: string; expiresAt: Date }> {
  const { order, restaurant, settings } = params;
  if (order.status !== "draft") {
    throw new OrderValidationError("ORDER_NOT_DRAFT", "Only an unconfirmed order can get a review link.");
  }
  if (order.items.length === 0) {
    throw new OrderValidationError("ORDER_EMPTY", "Add at least one item before sending a review link.");
  }
  if (!order.customerName.trim()) {
    throw new OrderValidationError("NAME_REQUIRED", "Get a name for the order before sending the link.");
  }
  if (!isUsablePhone(order.customerPhone)) {
    throw new OrderValidationError("NO_PHONE", "No usable mobile number to text the link to.");
  }
  const token = crypto.randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + settings.reviewTtlSeconds * 1000);
  await db.query(
    `UPDATE orders SET review_token_hash = $2, review_expires_at = $3, updated_at = now()
     WHERE id = $1`,
    [order.id, hashToken(token), expiresAt],
  );
  const url = `${env.APP_URL.replace(/\/$/, "")}/confirm/${token}`;
  await enqueueNotification(db, {
    orderId: order.id,
    kind: "review_sms",
    toNumber: order.customerPhone,
    body: reviewSmsBody(restaurant.name, url),
  });
  return { url, expiresAt };
}

export interface ReviewLookup {
  order: OrderWithItems;
  /** Draft past its review expiry — can never be confirmed. */
  expired: boolean;
}

export async function findOrderByReviewToken(
  db: Queryable,
  token: string,
): Promise<ReviewLookup | null> {
  if (!token || token.length > 64) return null;
  const res = await db.query(`SELECT id, status, review_expires_at FROM orders WHERE review_token_hash = $1`, [
    hashToken(token),
  ]);
  const row = res.rows[0] as { id: string; status: string; review_expires_at: Date | null } | undefined;
  if (!row) return null;
  const order = await getOrderWithItems(db, row.id);
  if (!order) return null;
  const expired =
    order.status === "draft" &&
    Boolean(order.reviewExpiresAt) &&
    order.reviewExpiresAt!.getTime() < Date.now();
  return { order, expired };
}

/**
 * The customer's explicit Confirm action. Idempotent: a duplicate tap
 * returns the already-confirmed order without creating anything twice.
 */
export async function confirmByReviewToken(
  db: pg.Pool,
  params: {
    token: string;
    restaurant: Restaurant;
    settings: RestaurantSettings;
    hours: RestaurantHoursRow[];
    /** Injectable clock for the open-hours recheck (tests pin it). */
    now?: Date;
  },
): Promise<{ order: OrderWithItems; alreadyConfirmed: boolean; trackUrl?: string }> {
  const lookup = await findOrderByReviewToken(db, params.token);
  if (!lookup) {
    throw new OrderValidationError("REVIEW_NOT_FOUND", "This link isn't valid.");
  }
  const { order } = lookup;
  if (order.status === "cancelled") {
    throw new OrderValidationError(
      "REVIEW_EXPIRED",
      "This order expired or was cancelled before it was confirmed. Please call us again.",
    );
  }
  if (order.status !== "draft") {
    // Single-use: once committed the token can only ever show status.
    return { order, alreadyConfirmed: true };
  }
  if (lookup.expired) {
    throw new OrderValidationError(
      "REVIEW_EXPIRED",
      "This order expired before it was confirmed. Please call us again.",
    );
  }
  // Recheck hours at the moment of commitment: an ASAP order can't start
  // against a closed kitchen no matter when the link is tapped.
  if (
    order.requestedAsap &&
    !openStateAt(params.hours, params.now ?? new Date(), params.restaurant.timezone).open
  ) {
    throw new OrderValidationError(
      "KITCHEN_CLOSED",
      "The kitchen has closed, so this order can't be confirmed. Please call us when we're open.",
    );
  }
  return confirmOrderWithNotifications(db, {
    orderId: order.id,
    restaurant: params.restaurant,
    settings: params.settings,
    idempotencyKey: `review-${order.id}`,
    actor: "customer_web",
  });
}

/**
 * Expiry sweep: review drafts that were never confirmed are cancelled so
 * they can't linger (they were never visible to the kitchen). Run
 * periodically from the worker.
 */
export async function expireStaleReviewDrafts(db: Queryable): Promise<number> {
  const res = await db.query(
    `UPDATE orders SET status = 'cancelled',
       internal_notes = internal_notes
         || CASE WHEN internal_notes = '' THEN '' ELSE E'\n' END
         || 'Review link expired without confirmation.',
       updated_at = now()
     WHERE status = 'draft' AND review_expires_at IS NOT NULL AND review_expires_at < now()
     RETURNING id`,
  );
  for (const row of res.rows as { id: string }[]) {
    await auditLog(db, {
      actor: "system",
      action: "order.review_expired",
      entityType: "order",
      entityId: row.id,
      changes: {},
    });
  }
  return res.rows.length;
}
