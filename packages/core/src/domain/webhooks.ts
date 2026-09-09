import crypto from "node:crypto";
import type { Queryable } from "../db/client";
import { env } from "../env";

/**
 * Outbound event webhooks (n8n integration).
 *
 * Events are enqueued into the notification outbox (kind='webhook') inside
 * the same transaction as the business change, then delivered by the SMS
 * worker loop with the same retry/backoff machinery. Payloads are signed
 * with HMAC-SHA256 (X-Meatbox-Signature) so the receiver can verify origin.
 *
 * No-ops entirely unless N8N_WEBHOOK_URL is configured.
 */

export type WebhookEvent = "order.confirmed" | "order.needs_review" | "owner_sms_failed";

export async function enqueueWebhookEvent(
  db: Queryable,
  params: { event: WebhookEvent; orderId?: string | null; payload: Record<string, unknown> },
): Promise<void> {
  if (!env.N8N_WEBHOOK_URL) return;
  const body = JSON.stringify({
    event: params.event,
    sentAt: new Date().toISOString(),
    ...params.payload,
  });
  await db.query(
    `INSERT INTO notification_attempts (order_id, kind, to_number, body)
     VALUES ($1, 'webhook', $2, $3)`,
    [params.orderId ?? null, env.N8N_WEBHOOK_URL, body],
  );
}

export function signWebhookBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export interface WebhookSender {
  send(url: string, body: string): Promise<{ sid: string }>;
}

export function createWebhookSender(): WebhookSender {
  return {
    async send(url: string, body: string) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.N8N_WEBHOOK_SECRET) {
        headers["X-Meatbox-Signature"] = signWebhookBody(body, env.N8N_WEBHOOK_SECRET);
        // Plain shared token too, so an n8n Code node can verify without
        // needing NODE_FUNCTION_ALLOW_BUILTIN=crypto on the instance.
        headers["X-Meatbox-Token"] = env.N8N_WEBHOOK_SECRET;
      }
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) {
        throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return { sid: `WH-${res.status}-${Date.now()}` };
    },
  };
}
