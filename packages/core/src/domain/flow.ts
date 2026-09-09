import type pg from "pg";
import { env } from "../env";
import { formatCents } from "../money";
import type { OrderWithItems, Restaurant, RestaurantSettings } from "../types";
import { confirmOrder } from "./orders";
import { customerSmsBody, enqueueNotification, ownerSmsBody } from "./notifications";
import { enqueueWebhookEvent } from "./webhooks";

/**
 * Confirm an order and, in the SAME transaction, enqueue the owner SMS
 * (and optional customer confirmation SMS). If any part fails, nothing
 * commits; once committed, the order and its notifications survive any
 * later provider outage.
 */
export async function confirmOrderWithNotifications(
  db: pg.Pool,
  params: {
    orderId: string;
    restaurant: Restaurant;
    settings: RestaurantSettings;
    idempotencyKey?: string;
    actor?: string;
  },
): Promise<{ order: OrderWithItems; alreadyConfirmed: boolean }> {
  const { restaurant, settings } = params;
  return confirmOrder(db, {
    orderId: params.orderId,
    orderNumberPrefix: settings.orderNumberPrefix,
    idempotencyKey: params.idempotencyKey,
    actor: params.actor,
    onConfirmed: async (tx, order) => {
      const ownerNumber = settings.ownerSmsNumber || env.OWNER_NOTIFICATION_PHONE;
      if (ownerNumber) {
        await enqueueNotification(tx, {
          orderId: order.id,
          kind: "owner_sms",
          toNumber: ownerNumber,
          body: ownerSmsBody(order, restaurant, env.APP_URL),
        });
      }
      if (settings.customerSmsEnabled && order.customerPhone) {
        await enqueueNotification(tx, {
          orderId: order.id,
          kind: "customer_sms",
          toNumber: order.customerPhone,
          body: customerSmsBody(order, restaurant),
        });
      }
      await enqueueWebhookEvent(tx, {
        event: "order.confirmed",
        orderId: order.id,
        payload: {
          orderNumber: order.publicOrderNumber,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          orderType: order.orderType,
          pickup: order.requestedAsap ? "ASAP" : (order.requestedTime?.toISOString() ?? null),
          total: formatCents(order.totalCents),
          items: order.items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity })),
        },
      });
    },
  });
}
