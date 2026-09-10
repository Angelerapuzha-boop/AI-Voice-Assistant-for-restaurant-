import {
  camelRows,
  getDefaultRestaurant,
  searchOrders,
  type OrderItem,
  type OrderItemModifier,
  type OrderStatus,
  type OrderType,
} from "@meatbox/core";
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

  // include=items: everything the kitchen board needs in 3 bulk queries
  // (instead of one HTTP request per order).
  if (url.searchParams.get("include") === "items" && orders.length > 0) {
    const ids = orders.map((o) => o.id);
    const itemsRes = await db().query(
      `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY sort_order, id`,
      [ids],
    );
    const items = camelRows<Omit<OrderItem, "modifiers">>(itemsRes.rows);
    const modsRes = await db().query(
      `SELECT * FROM order_item_modifiers WHERE order_item_id = ANY($1) ORDER BY id`,
      [items.map((i) => i.id)],
    );
    const mods = camelRows<OrderItemModifier>(modsRes.rows);
    const withItems = orders.map((o) => ({
      ...o,
      items: items
        .filter((i) => i.orderId === o.id)
        .map((i) => ({ ...i, modifiers: mods.filter((m) => m.orderItemId === i.id) })),
    }));
    return Response.json({ orders: withItems });
  }

  return Response.json({ orders });
});
