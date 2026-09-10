import { z } from "zod";
import {
  completeOrderWithPayment,
  enqueueNotification,
  getDefaultRestaurant,
  getSettings,
  isUsablePhone,
  recalcQueueEstimates,
  updateOrderStatus,
  OrderValidationError,
  type OrderStatus,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

const bodySchema = z.object({
  status: z.enum(["new", "accepted", "preparing", "ready", "completed", "cancelled"]),
  // Handover of an unpaid order (spec 14): settle at the counter or record
  // an owner-authorised exception — otherwise 'completed' is refused.
  settle: z.enum(["cash", "card", "tap", "exception"]).optional(),
  exceptionReason: z.string().max(200).optional(),
});

export const POST = guarded(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid status" }, { status: 400 });
  try {
    const order =
      parsed.data.status === "completed"
        ? await completeOrderWithPayment(db(), {
            orderId: id,
            actor: user.email,
            settle: parsed.data.settle,
            exceptionReason: parsed.data.exceptionReason,
          })
        : await updateOrderStatus(db(), id, parsed.data.status as OrderStatus, user.email);
    const restaurant = await getDefaultRestaurant(db());
    const settings = await getSettings(db(), restaurant.id);
    // Ready notification (deduplicated: only on the transition into READY,
    // which the status flow permits at most once per order).
    if (parsed.data.status === "ready" && order.source === "phone" && isUsablePhone(order.customerPhone)) {
      if (settings.customerSmsEnabled) {
        await enqueueNotification(db(), {
          orderId: order.id,
          kind: "customer_sms",
          toNumber: order.customerPhone,
          body: `Your ${restaurant.name} order #${order.publicOrderNumber} is ready for collection.`,
        });
      }
    }
    // Kitchen state changed: refresh queued orders' current estimates
    // (first promises stay untouched).
    if (["preparing", "ready", "completed", "cancelled"].includes(parsed.data.status)) {
      await recalcQueueEstimates(db(), {
        restaurantId: restaurant.id,
        settings,
        delayNotify: {
          restaurant,
          customerSmsEnabled: settings.customerSmsEnabled,
          thresholdSeconds: settings.delayNotifyThresholdSeconds,
        },
      });
    }
    return Response.json({ order });
  } catch (err) {
    if (err instanceof OrderValidationError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
