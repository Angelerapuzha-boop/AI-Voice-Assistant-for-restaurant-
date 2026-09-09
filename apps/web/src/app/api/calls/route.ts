import { getDefaultRestaurant, listCalls } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const calls = await listCalls(db(), restaurant.id, 100);
  return Response.json({ calls });
});
