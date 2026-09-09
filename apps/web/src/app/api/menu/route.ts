import {
  getDefaultRestaurant,
  getModifierGroups,
  listCategories,
  listItems,
} from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

/** Full menu tree for the admin editor. */
export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const [categories, items] = await Promise.all([
    listCategories(db(), restaurant.id),
    listItems(db(), restaurant.id, { includeInactive: false }),
  ]);
  const withGroups = await Promise.all(
    items.map(async (item) => ({ ...item, groups: await getModifierGroups(db(), item.id) })),
  );
  return Response.json({ restaurantId: restaurant.id, categories, items: withGroups });
});
