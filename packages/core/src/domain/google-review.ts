import type pg from "pg";
import { withTransaction } from "../db/client";
import { enqueueNotification } from "./notifications";
import { isUsablePhone } from "./customers";
import type { Restaurant, RestaurantSettings } from "../types";

/**
 * One hour after an order completes, ask the customer for a Google
 * review by SMS — at most ONCE per customer, ever (keyed by phone via
 * the customers table). Runs from the maintenance worker every minute;
 * inert until Settings carries a Google review URL.
 */
export async function sweepGoogleReviewSms(
  db: pg.Pool,
  params: { restaurant: Restaurant; settings: RestaurantSettings; now?: Date },
): Promise<number> {
  const { restaurant, settings } = params;
  const now = params.now ?? new Date();
  if (!settings.customerSmsEnabled || !settings.googleReviewUrl) return 0;

  const due = await db.query(
    `SELECT DISTINCT ON (c.id) c.id AS customer_id, o.id AS order_id,
            o.customer_phone, COALESCE(NULLIF(o.customer_name, ''), '') AS customer_name
     FROM orders o
     JOIN customers c ON c.restaurant_id = o.restaurant_id AND c.phone_e164 = o.customer_phone
     WHERE o.restaurant_id = $1 AND o.status = 'completed'
       AND o.customer_phone <> '' AND o.updated_at < $2::timestamptz - interval '1 hour'
       AND c.review_sms_sent_at IS NULL
     ORDER BY c.id, o.updated_at
     LIMIT 20`,
    [restaurant.id, now],
  );

  let sent = 0;
  for (const row of due.rows as {
    customer_id: string;
    order_id: string;
    customer_phone: string;
    customer_name: string;
  }[]) {
    if (!isUsablePhone(row.customer_phone)) continue;
    await withTransaction(db, async (tx) => {
      // Lock the customer: exactly one review ask per phone number, ever,
      // even under concurrent sweeps.
      const locked = await tx.query(
        `SELECT review_sms_sent_at FROM customers WHERE id = $1 FOR UPDATE`,
        [row.customer_id],
      );
      if ((locked.rows[0] as { review_sms_sent_at: Date | null } | undefined)?.review_sms_sent_at) {
        return;
      }
      await tx.query(`UPDATE customers SET review_sms_sent_at = now() WHERE id = $1`, [
        row.customer_id,
      ]);
      const first = row.customer_name.split(/\s+/)[0] ?? "";
      await enqueueNotification(tx, {
        orderId: row.order_id,
        kind: "review_sms",
        toNumber: row.customer_phone,
        body:
          `Thanks for ordering from ${restaurant.name}${first ? `, ${first}` : ""}! ` +
          `If you enjoyed your meal, a quick Google review would mean a lot: ${settings.googleReviewUrl}`,
      });
      sent++;
    });
  }
  return sent;
}
