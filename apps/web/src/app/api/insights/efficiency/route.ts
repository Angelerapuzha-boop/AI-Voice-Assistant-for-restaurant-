import { getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";
import { computeEfficiency } from "@/lib/efficiency";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  return Response.json(await computeEfficiency(db(), restaurant.id));
});
