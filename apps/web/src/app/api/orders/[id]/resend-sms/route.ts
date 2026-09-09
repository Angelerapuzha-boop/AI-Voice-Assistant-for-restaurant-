import {
  enqueueNotification,
  env,
  getDefaultRestaurant,
  getOrderWithItems,
  getSettings,
  ownerSmsBody,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

/** Re-queue the owner SMS for an order (e.g. after a provider outage). */
export const POST = guarded(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser();
  const { id } = await ctx.params;
  const order = await getOrderWithItems(db(), id);
  if (!order || !order.publicOrderNumber) {
    return Response.json({ error: "order not found or not confirmed" }, { status: 404 });
  }
  const restaurant = await getDefaultRestaurant(db());
  const settings = await getSettings(db(), restaurant.id);
  const toNumber = settings.ownerSmsNumber || env.OWNER_NOTIFICATION_PHONE;
  if (!toNumber) return Response.json({ error: "no owner SMS number configured" }, { status: 400 });
  await enqueueNotification(db(), {
    orderId: order.id,
    kind: "owner_sms",
    toNumber,
    body: ownerSmsBody(order, restaurant, env.APP_URL),
  });
  await db().query(`UPDATE orders SET owner_sms_alert = false WHERE id = $1`, [order.id]);
  return Response.json({ ok: true });
});
