import { getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";
import { computeForecast } from "@/lib/forecast";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  return Response.json({ rows: await computeForecast(db(), restaurant.id) });
});
