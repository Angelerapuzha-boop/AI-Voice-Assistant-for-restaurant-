import type { Queryable } from "../db/client";
import { env } from "../env";
import { formatCents } from "../money";
import { camelRow, camelRows, type OrderWithItems, type Restaurant } from "../types";
import { describeOrderItems } from "./orders";
import { createWebhookSender, enqueueWebhookEvent, type WebhookSender } from "./webhooks";
import type { SquareOrderSender } from "./square";

/**
 * Notification outbox. Enqueue rows in the same transaction as the order
 * confirmation; a worker loop sends them with retries. A failed SMS never
 * un-confirms an order.
 */

export interface NotificationAttempt {
  id: string;
  orderId: string | null;
  kind: "owner_sms" | "customer_sms" | "review_sms" | "webhook" | "square_order";
  toNumber: string;
  body: string;
  status: "pending" | "sent" | "failed" | "gave_up";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  sentAt: Date | null;
  providerSid: string | null;
}

export function formatLocalTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function ownerSmsBody(
  order: OrderWithItems,
  restaurant: Restaurant,
  dashboardUrl: string,
): string {
  const lines: string[] = [];
  lines.push(`${restaurant.name.toUpperCase()} NEW ORDER #${order.publicOrderNumber}`);
  lines.push("");
  lines.push(order.orderType === "takeaway" ? "TAKEAWAY" : "DINE-IN");
  if (order.customerName) lines.push(`Name: ${order.customerName}`);
  if (order.customerPhone) lines.push(`Phone: ${order.customerPhone}`);
  if (order.orderType === "takeaway") {
    lines.push(
      `Pickup: ${order.requestedAsap || !order.requestedTime ? "ASAP" : formatLocalTime(order.requestedTime, restaurant.timezone)}`,
    );
  } else if (!order.requestedAsap && order.requestedTime) {
    lines.push(`Arrival: ${formatLocalTime(order.requestedTime, restaurant.timezone)}`);
  }
  lines.push("");
  lines.push(describeOrderItems(order));
  lines.push("");
  lines.push(`TOTAL: ${formatCents(order.totalCents)}`);
  if (order.allergyNotes) {
    lines.push("");
    lines.push(`!! ALLERGY: ${order.allergyNotes}`);
  }
  if (order.customerNotes) {
    lines.push("");
    lines.push(`Notes: ${order.customerNotes}`);
  }
  lines.push("");
  lines.push(`Received: ${formatLocalTime(order.confirmedAt ?? new Date(), restaurant.timezone)}`);
  if (dashboardUrl) {
    lines.push(`Open order: ${dashboardUrl}/kitchen`);
  }
  return lines.join("\n");
}

export function customerSmsBody(order: OrderWithItems, restaurant: Restaurant): string {
  const firstName = order.customerName.split(" ")[0] ?? "";
  const when =
    order.requestedAsap || !order.requestedTime
      ? "as soon as possible"
      : `approximately ${formatLocalTime(order.requestedTime, restaurant.timezone)}`;
  const type = order.orderType === "takeaway" ? `Takeaway, ${when}` : "Dine-in";
  return (
    `Thanks${firstName ? " " + firstName : ""}. ${restaurant.name} has received order ` +
    `${order.publicOrderNumber}. ${type}. Total ${formatCents(order.totalCents)}.`
  );
}

export async function enqueueNotification(
  db: Queryable,
  params: { orderId: string | null; kind: NotificationAttempt["kind"]; toNumber: string; body: string },
): Promise<string> {
  const res = await db.query(
    `INSERT INTO notification_attempts (order_id, kind, to_number, body)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.orderId, params.kind, params.toNumber, params.body],
  );
  return (res.rows[0] as { id: string }).id;
}

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [0, 10, 30, 60, 180, 600];

export interface SmsSender {
  send(to: string, body: string): Promise<{ sid: string }>;
}

/** Twilio-backed sender; SMS_MODE=log records without sending (dev safety). */
export function createSmsSender(): SmsSender {
  if (env.SMS_MODE !== "live") {
    return {
      async send(to: string, body: string) {
        console.log(`[sms:log-mode] to=${to}\n${body}`);
        return { sid: `LOGGED-${Date.now()}` };
      },
    };
  }
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("SMS_MODE=live requires TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER");
  }
  return {
    async send(to: string, body: string) {
      const params: Record<string, string> = { To: to, From: from, Body: body };
      // Delivery-status callbacks (queued/sent/delivered are not synonyms).
      if (env.VOICE_PUBLIC_URL.startsWith("https")) {
        params.StatusCallback = `${env.VOICE_PUBLIC_URL.replace(/\/$/, "")}/twilio/sms-status`;
      }
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(params).toString(),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Twilio ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as { sid: string };
      return { sid: json.sid };
    },
  };
}

/**
 * Process due pending notifications once. Returns number processed.
 * Call from a worker loop (voice service runs this every few seconds).
 */
export async function processPendingNotifications(
  db: Queryable,
  sender: SmsSender,
  webhookSender: WebhookSender = createWebhookSender(),
  squareSender?: SquareOrderSender,
): Promise<number> {
  const res = await db.query(
    `SELECT * FROM notification_attempts
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
     ORDER BY created_at
     LIMIT 10
     FOR UPDATE SKIP LOCKED`,
  );
  const due = camelRows<NotificationAttempt>(res.rows);
  for (const attempt of due) {
    try {
      const { sid } =
        attempt.kind === "webhook"
          ? await webhookSender.send(attempt.toNumber, attempt.body)
          : attempt.kind === "square_order"
            ? await (squareSender
                ? squareSender.send(attempt.toNumber, attempt.body)
                : Promise.reject(new Error("no Square sender configured")))
            : await sender.send(attempt.toNumber, attempt.body);
      await db.query(
        `UPDATE notification_attempts
         SET status = 'sent', attempts = attempts + 1, sent_at = now(), provider_sid = $2
         WHERE id = $1`,
        [attempt.id, sid],
      );
    } catch (err) {
      const attempts = attempt.attempts + 1;
      const gaveUp = attempts >= MAX_ATTEMPTS;
      const backoff = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)] ?? 600;
      await db.query(
        `UPDATE notification_attempts
         SET status = $2, attempts = $3, last_error = $4,
             next_attempt_at = now() + ($5 || ' seconds')::interval
         WHERE id = $1`,
        [attempt.id, gaveUp ? "gave_up" : "failed", attempts, String((err as Error).message).slice(0, 500), String(backoff)],
      );
      if (gaveUp && attempt.kind === "owner_sms" && attempt.orderId) {
        // Surface loudly on the dashboard — the kitchen must not miss this order.
        await db.query(`UPDATE orders SET owner_sms_alert = true, updated_at = now() WHERE id = $1`, [
          attempt.orderId,
        ]);
        // Independent alert channel: tell n8n the app's own SMS path is failing.
        const orderRes = await db.query(
          `SELECT public_order_number, customer_name, total_cents FROM orders WHERE id = $1`,
          [attempt.orderId],
        );
        const order = orderRes.rows[0] as
          | { public_order_number: string | null; customer_name: string; total_cents: number }
          | undefined;
        await enqueueWebhookEvent(db, {
          event: "owner_sms_failed",
          orderId: attempt.orderId,
          payload: {
            orderNumber: order?.public_order_number ?? "",
            customerName: order?.customer_name ?? "",
            total: formatCents(order?.total_cents ?? 0),
            lastError: String((err as Error).message).slice(0, 200),
          },
        });
      }
    }
  }
  return due.length;
}

export async function listNotificationsForOrder(
  db: Queryable,
  orderId: string,
): Promise<NotificationAttempt[]> {
  const res = await db.query(
    `SELECT * FROM notification_attempts WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  return camelRows<NotificationAttempt>(res.rows);
}

export async function getNotification(db: Queryable, id: string): Promise<NotificationAttempt | null> {
  const res = await db.query(`SELECT * FROM notification_attempts WHERE id = $1`, [id]);
  return res.rows[0] ? camelRow<NotificationAttempt>(res.rows[0]) : null;
}
