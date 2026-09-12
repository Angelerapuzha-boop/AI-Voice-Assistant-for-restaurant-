import { getDefaultRestaurant, listInventory, stockStatus } from "@meatbox/core";
import { db } from "@/lib/db";
import { guarded, requireUser } from "@/lib/session";

/** Aggregates behind the Daily insights dashboard. All money in cents. */
export const GET = guarded(async () => {
  await requireUser();
  const restaurant = await getDefaultRestaurant(db());
  const tz = restaurant.timezone;
  const rid = restaurant.id;

  const [today, byHour, revenue14, sources, topItems, calls, soldOut] = await Promise.all([
    db().query(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS revenue,
              COALESCE(AVG(total_cents), 0)::int AS avg_order
       FROM orders
       WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
         AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [rid, tz],
    ),
    db().query(
      `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour,
              COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS revenue
       FROM orders
       WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
         AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
       GROUP BY 1 ORDER BY 1`,
      [rid, tz],
    ),
    db().query(
      `SELECT (created_at AT TIME ZONE $2)::date AS day,
              COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS revenue
       FROM orders
       WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
         AND created_at > now() - interval '14 days'
       GROUP BY 1 ORDER BY 1`,
      [rid, tz],
    ),
    db().query(
      `SELECT source, COUNT(*)::int AS orders, COALESCE(SUM(total_cents), 0)::bigint AS revenue
       FROM orders
       WHERE restaurant_id = $1 AND status NOT IN ('draft', 'cancelled')
         AND created_at > now() - interval '7 days'
       GROUP BY 1 ORDER BY 2 DESC`,
      [rid],
    ),
    db().query(
      `SELECT oi.name_snapshot AS name, SUM(oi.quantity)::int AS qty,
              COALESCE(SUM(oi.line_total_cents), 0)::bigint AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = $1 AND o.status NOT IN ('draft', 'cancelled')
         AND o.created_at > now() - interval '7 days'
       GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [rid],
    ),
    db().query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE outcome = 'ORDER_COMPLETED')::int AS completed
       FROM calls
       WHERE restaurant_id = $1
         AND (started_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`,
      [rid, tz],
    ),
    db().query(
      `SELECT name FROM menu_items
       WHERE restaurant_id = $1 AND active AND (is_sold_out OR NOT is_available)
       ORDER BY name`,
      [rid],
    ),
  ]);

  // Live activity rail: latest order, stock and call events, one stream.
  const activity = await db().query(
    `SELECT * FROM (
       SELECT 'order' AS kind,
              CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'confirmed' END AS event,
              COALESCE(public_order_number, '') AS ref,
              COALESCE(NULLIF(customer_name, ''), 'Walk-in') AS label,
              total_cents::numeric AS amount,
              COALESCE(confirmed_at, updated_at) AS at
       FROM orders
       WHERE restaurant_id = $1 AND confirmed_at IS NOT NULL
       UNION ALL
       SELECT 'stock', m.reason, ii.name, COALESCE(NULLIF(m.actor, ''), 'auto'), m.delta::numeric, m.created_at
       FROM inventory_movements m JOIN inventory_items ii ON ii.id = m.inventory_item_id
       WHERE ii.restaurant_id = $1 AND m.reason IN ('restock', 'adjustment')
       UNION ALL
       SELECT 'call', COALESCE(outcome, 'in progress'), '', COALESCE(NULLIF(caller_number, ''), 'unknown'),
              COALESCE(duration_seconds, 0)::numeric, started_at
       FROM calls WHERE restaurant_id = $1
     ) t ORDER BY at DESC NULLS LAST LIMIT 25`,
    [rid],
  );

  const inventory = await listInventory(db(), rid);
  const lowStock = inventory
    .map((i) => ({ ...i, status: stockStatus(i) }))
    .filter((i) => i.status !== "ok")
    .sort((a, b) => a.currentQty - b.currentQty);

  return Response.json({
    generatedAt: new Date().toISOString(),
    timezone: tz,
    today: today.rows[0],
    byHour: byHour.rows,
    revenue14: revenue14.rows,
    sources: sources.rows,
    topItems: topItems.rows,
    callsToday: calls.rows[0],
    soldOut: soldOut.rows.map((r) => (r as { name: string }).name),
    lowStock,
    activity: activity.rows,
  });
});
