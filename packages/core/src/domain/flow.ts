import type pg from "pg";
import { env } from "../env";
import { formatCents } from "../money";
import type { OrderType, OrderWithItems, Restaurant, RestaurantSettings } from "../types";
import { addOrderItem, confirmOrder, createDraft, OrderValidationError } from "./orders";
import { customerSmsBody, enqueueNotification, ownerSmsBody } from "./notifications";
import { enqueueWebhookEvent } from "./webhooks";
import { enqueueSquareOrderPush } from "./square";

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
      await enqueueSquareOrderPush(tx, restaurant.id, order);
    },
  });
}

/**
 * Cashier POS order: build + confirm in one shot. No owner SMS (the cashier
 * is standing in the shop); still pushed to Square when connected, and it
 * pops onto the kitchen board like any phone order.
 */
export async function placePosOrder(
  db: pg.Pool,
  params: {
    restaurant: Restaurant;
    settings: RestaurantSettings;
    actorEmail: string;
    orderType: OrderType;
    customerName?: string;
    customerNotes?: string;
    paymentMethod: "cash" | "card" | "tap";
    items: {
      menuItemId: string;
      quantity: number;
      modifierIds?: string[];
      removals?: string[];
      specialInstructions?: string;
    }[];
  },
): Promise<OrderWithItems> {
  if (params.items.length === 0) {
    throw new OrderValidationError("ORDER_EMPTY", "Add at least one item.");
  }
  const draft = await createDraft(db, {
    restaurantId: params.restaurant.id,
    customerName: params.customerName?.trim() || "Walk-in",
    orderType: params.orderType,
    source: "pos",
  });
  for (const item of params.items) {
    await addOrderItem(db, {
      orderId: draft.id,
      menuItemId: item.menuItemId,
      quantity: item.quantity,
      modifierIds: item.modifierIds ?? [],
      removals: item.removals ?? [],
      specialInstructions: item.specialInstructions,
    });
  }
  const { order } = await confirmOrder(db, {
    orderId: draft.id,
    orderNumberPrefix: params.settings.orderNumberPrefix,
    actor: params.actorEmail,
    onConfirmed: async (tx, confirmed) => {
      await tx.query(
        `UPDATE orders SET payment_method = $2, paid_at = now(),
           customer_notes = $3, updated_at = now() WHERE id = $1`,
        [confirmed.id, params.paymentMethod, params.customerNotes ?? ""],
      );
      await enqueueSquareOrderPush(tx, params.restaurant.id, confirmed);
    },
  });
  return order;
}
