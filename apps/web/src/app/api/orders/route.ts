import { getDefaultRestaurant, searchOrders, type OrderStatus, type OrderType } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

export const GET = guarded(async (req: Request) => {
  await requireUser();
  const url = new URL(req.url);
  const restaurant = await getDefaultRestaurant(db());
  const status = url.searchParams.get("status") ?? undefined;
  const orders = await searchOrders(db(), {
    restaurantId: restaurant.id,
    q: url.searchParams.get("q") ?? undefined,
    status: (status as OrderStatus | "active" | undefined) ?? undefined,
    orderType: (url.searchParams.get("type") as OrderType | null) ?? undefined,
    todayOnly: url.searchParams.get("today") === "1",
    date: url.searchParams.get("date") ?? undefined,
    timezone: restaurant.timezone,
  });
  return Response.json({ orders });
});
