import { getDefaultRestaurant } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";
import { getOrGenerateBriefing } from "@/lib/ai-advisor";

export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  return Response.json(await getOrGenerateBriefing(db(), restaurant));
});

/** Owner hit Regenerate: force a fresh briefing now. */
export const POST = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  return Response.json(await getOrGenerateBriefing(db(), restaurant, true));
});
