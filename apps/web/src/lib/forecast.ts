import type pg from "pg";
import { listInventory } from "@meatbox/core";

/**
 * Demand forecast per dish: how much sold last week vs the week before,
 * the projected next week, and how long current stock lasts. Targets a
 * 10-day cover so a blocked shipment never leaves a customer waiting.
 */

export interface ForecastRow {
  name: string;
  unit: string;
  lastWeek: number;
  prevWeek: number;
  trendPct: number | null;
  predictedNextWeek: number;
  currentQty: number;
  coverDays: number | null;
  suggestedOrderQty: number;
  action: "restock_now" | "order_this_week" | "ok" | "no_demand";
}

export async function computeForecast(db: pg.Pool, restaurantId: string): Promise<ForecastRow[]> {
  const demand = await db.query(
    `SELECT oi.name_snapshot AS name,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at > now() - interval '7 days'), 0)::int AS last_week,
            COALESCE(SUM(oi.quantity) FILTER (WHERE o.created_at <= now() - interval '7 days'), 0)::int AS prev_week
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND o.status NOT IN ('draft', 'cancelled')
       AND o.created_at > now() - interval '14 days'
     GROUP BY 1`,
    [restaurantId],
  );
  const sold = new Map(
    (demand.rows as { name: string; last_week: number; prev_week: number }[]).map((r) => [
      r.name,
      { lastWeek: r.last_week, prevWeek: r.prev_week },
    ]),
  );

  const dishes = await listInventory(db, restaurantId, "dish");
  const rows: ForecastRow[] = [];
  for (const item of dishes) {
    const d = sold.get(item.name) ?? { lastWeek: 0, prevWeek: 0 };
    const trendPct =
      d.prevWeek > 0 ? Math.round(((d.lastWeek - d.prevWeek) / d.prevWeek) * 100) : null;
    // Project the trend forward, capped so one hype week can't explode it.
    const growth = trendPct === null ? 1 : 1 + Math.max(-0.5, Math.min(0.5, trendPct / 100));
    const predicted = Math.round(d.lastWeek * growth);
    const dailyPace = predicted / 7;
    const coverDays = dailyPace > 0 ? Math.round((item.currentQty / dailyPace) * 10) / 10 : null;
    // Early-purchase target: 10 days of cover (blocked-shipping buffer).
    const target = Math.ceil(dailyPace * 10 * 1.1);
    const suggestedOrderQty = Math.max(0, target - Math.floor(item.currentQty));
    let action: ForecastRow["action"] = "ok";
    if (d.lastWeek === 0 && d.prevWeek === 0) action = "no_demand";
    else if (coverDays !== null && coverDays < 3) action = "restock_now";
    else if (coverDays !== null && coverDays < 10) action = "order_this_week";
    rows.push({
      name: item.name,
      unit: item.unit,
      lastWeek: d.lastWeek,
      prevWeek: d.prevWeek,
      trendPct,
      predictedNextWeek: predicted,
      currentQty: item.currentQty,
      coverDays,
      suggestedOrderQty: action === "ok" || action === "no_demand" ? 0 : suggestedOrderQty,
      action,
    });
  }
  // Most urgent first, then by demand.
  const rank: Record<ForecastRow["action"], number> = {
    restock_now: 0,
    order_this_week: 1,
    ok: 2,
    no_demand: 3,
  };
  return rows.sort((a, b) => rank[a.action] - rank[b.action] || b.lastWeek - a.lastWeek);
}
