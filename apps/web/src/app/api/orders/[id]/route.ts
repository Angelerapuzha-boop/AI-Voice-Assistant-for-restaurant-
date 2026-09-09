import { getOrderWithItems, listNotificationsForOrder } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireUser();
  const { id } = await ctx.params;
  const order = await getOrderWithItems(db(), id);
  if (!order) return Response.json({ error: "not found" }, { status: 404 });
  const notifications = await listNotificationsForOrder(db(), id);
  return Response.json({ order, notifications });
});
