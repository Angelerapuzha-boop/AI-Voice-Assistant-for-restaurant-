import crypto from "node:crypto";
import type { Queryable } from "../db/client";
import { camelRow, type OrderWithItems } from "../types";
import { getOrderWithItems } from "./orders";

/**
 * Returning customers + repeat orders (spec section 9).
 * The phone number is recognition, not authentication: history is only
 * reachable through the current call's server-verified caller ID, and
 * every repeat lookup is scoped to that customer + restaurant.
 */

export function isUsablePhone(phone: string | undefined | null): phone is string {
  return Boolean(phone && /^\+?[0-9]{6,15}$/.test(phone));
}

export async function upsertCustomerForOrder(
  tx: Queryable,
  order: { id: string; restaurantId: string; customerPhone: string; customerName: string },
): Promise<void> {
  if (!isUsablePhone(order.customerPhone)) return;
  const res = await tx.query(
    `INSERT INTO customers (restaurant_id, phone_e164, display_name, last_order_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (restaurant_id, phone_e164) DO UPDATE SET
       display_name = CASE WHEN customers.display_name = '' THEN EXCLUDED.display_name
                           ELSE customers.display_name END,
       last_order_at = now()
     RETURNING id`,
    [order.restaurantId, order.customerPhone, order.customerName],
  );
  await tx.query(`UPDATE orders SET customer_id = $2 WHERE id = $1`, [
    order.id,
    (res.rows[0] as { id: string }).id,
  ]);
}

export interface RepeatCandidate {
  order: OrderWithItems;
  customerName: string;
}

/** Most recent fulfilled/accepted order for this caller (never drafts). */
export async function getLastOrderForPhone(
  db: Queryable,
  restaurantId: string,
  phone: string,
): Promise<RepeatCandidate | null> {
  if (!isUsablePhone(phone)) return null;
  const customer = await db.query(
    `SELECT id, display_name, history_enabled FROM customers
     WHERE restaurant_id = $1 AND phone_e164 = $2`,
    [restaurantId, phone],
  );
  const row = customer.rows[0] as
    | { id: string; display_name: string; history_enabled: boolean }
    | undefined;
  if (!row || !row.history_enabled) return null;
  const orderRes = await db.query(
    `SELECT id FROM orders
     WHERE restaurant_id = $1 AND customer_id = $2
       AND status IN ('new', 'accepted', 'preparing', 'ready', 'completed')
     ORDER BY confirmed_at DESC NULLS LAST LIMIT 1`,
    [restaurantId, row.id],
  );
  if (!orderRes.rows[0]) return null;
  const order = await getOrderWithItems(db, (orderRes.rows[0] as { id: string }).id);
  if (!order) return null;
  return { order, customerName: row.display_name };
}

// ------------------------------------------------------------------ tracking

export function newTrackingToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(18).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

export async function findOrderByTrackingToken(
  db: Queryable,
  token: string,
): Promise<OrderWithItems | null> {
  if (!token || token.length > 64) return null;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const res = await db.query(`SELECT id FROM orders WHERE tracking_token_hash = $1`, [hash]);
  if (!res.rows[0]) return null;
  return getOrderWithItems(db, (res.rows[0] as { id: string }).id);
}
