import { getDefaultRestaurant, listRecentPayments } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const payments = await listRecentPayments(db(), restaurant.id);
  return Response.json({ payments });
});
