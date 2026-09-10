import type { Queryable } from "../db/client";
import type { RestaurantSettings } from "../types";

/**
 * Deterministic, explainable kitchen-ready estimator (lane model).
 * The kitchen is treated as `kitchen_capacity` parallel lanes. Active
 * orders (new/accepted/preparing) occupy lanes until their current
 * estimate; the new order takes the earliest-free lane. This is an
 * approximation to calibrate, never model arithmetic, and it is computed
 * by the application - the AI only speaks the result.
 */

export interface EtaInput {
  /** Active orders occupying the kitchen, oldest first. */
  active: { estimatedReadyAt: Date | null; confirmedAt: Date | null }[];
  capacity: number;
  simpleBaselineSeconds: number;
  complexBaselineSeconds: number;
  minPrepMinutes: number;
  /** Line count + total quantity of the order being estimated. */
  lineCount: number;
  quantityTotal: number;
  now: Date;
}

export function estimateReadyAt(input: EtaInput): Date {
  const { now } = input;
  const duration =
    (input.lineCount >= 3 || input.quantityTotal >= 4
      ? input.complexBaselineSeconds
      : input.simpleBaselineSeconds) * 1000;

  // Lane availability from active workload.
  const lanes: number[] = Array.from({ length: Math.max(1, input.capacity) }, () => now.getTime());
  const sorted = [...input.active].sort(
    (a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0),
  );
  for (const order of sorted) {
    const remainingUntil = Math.max(
      now.getTime(),
      order.estimatedReadyAt?.getTime() ?? now.getTime() + input.simpleBaselineSeconds * 1000,
    );
    // earliest-available lane takes the order
    let idx = 0;
    for (let i = 1; i < lanes.length; i++) if (lanes[i]! < lanes[idx]!) idx = i;
    lanes[idx] = Math.max(lanes[idx]!, remainingUntil);
  }
  let idx = 0;
  for (let i = 1; i < lanes.length; i++) if (lanes[i]! < lanes[idx]!) idx = i;
  const start = Math.max(now.getTime(), lanes[idx]!);
  let ready = start + duration;

  // Floor at the configured minimum prep time, then round UP to 5 minutes
  // so spoken estimates stay stable and honest.
  ready = Math.max(ready, now.getTime() + input.minPrepMinutes * 60_000);
  const fiveMin = 5 * 60_000;
  ready = Math.ceil(ready / fiveMin) * fiveMin;
  return new Date(ready);
}

/** Load active kitchen workload + settings and estimate for a new order. */
export async function estimateForNewOrder(
  db: Queryable,
  params: {
    restaurantId: string;
    settings: RestaurantSettings & {
      kitchenCapacity?: number;
      simpleBaselineSeconds?: number;
      complexBaselineSeconds?: number;
    };
    lineCount: number;
    quantityTotal: number;
    now?: Date;
  },
): Promise<Date> {
  const res = await db.query(
    `SELECT current_estimated_ready_at, confirmed_at FROM orders
     WHERE restaurant_id = $1 AND status IN ('new', 'accepted', 'preparing')`,
    [params.restaurantId],
  );
  return estimateReadyAt({
    active: res.rows.map((r) => {
      const row = r as { current_estimated_ready_at: Date | null; confirmed_at: Date | null };
      return { estimatedReadyAt: row.current_estimated_ready_at, confirmedAt: row.confirmed_at };
    }),
    capacity: params.settings.kitchenCapacity ?? 3,
    simpleBaselineSeconds: params.settings.simpleBaselineSeconds ?? 600,
    complexBaselineSeconds: params.settings.complexBaselineSeconds ?? 1200,
    minPrepMinutes: params.settings.minPrepMinutes,
    lineCount: params.lineCount,
    quantityTotal: params.quantityTotal,
    now: params.now ?? new Date(),
  });
}

/**
 * Re-run the lane simulation for all queued orders after the kitchen state
 * changes (start/ready/cancel). PREPARING orders keep their estimates;
 * NEW/ACCEPTED orders get fresh current estimates. First promises are
 * never rewritten (spec: performance is measured against them).
 */
export async function recalcQueueEstimates(
  db: Queryable,
  params: {
    restaurantId: string;
    settings: {
      kitchenCapacity: number;
      simpleBaselineSeconds: number;
      complexBaselineSeconds: number;
      minPrepMinutes: number;
    };
    now?: Date;
  },
): Promise<number> {
  const now = params.now ?? new Date();
  const res = await db.query(
    `SELECT o.id, o.status, o.confirmed_at, o.current_estimated_ready_at,
            COUNT(oi.id)::int AS line_count, COALESCE(SUM(oi.quantity), 0)::int AS quantity_total
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.restaurant_id = $1 AND o.status IN ('new', 'accepted', 'preparing')
     GROUP BY o.id ORDER BY o.confirmed_at NULLS LAST, o.id`,
    [params.restaurantId],
  );
  const lanes: number[] = Array.from(
    { length: Math.max(1, params.settings.kitchenCapacity) },
    () => now.getTime(),
  );
  const pickLane = () => {
    let idx = 0;
    for (let i = 1; i < lanes.length; i++) if (lanes[i]! < lanes[idx]!) idx = i;
    return idx;
  };
  let updated = 0;
  for (const r of res.rows) {
    const row = r as {
      id: string;
      status: string;
      current_estimated_ready_at: Date | null;
      line_count: number;
      quantity_total: number;
    };
    if (row.status === "preparing") {
      const until = Math.max(
        now.getTime() + 60_000, // overdue work never shows a past time
        row.current_estimated_ready_at?.getTime() ?? now.getTime(),
      );
      const idx = pickLane();
      lanes[idx] = Math.max(lanes[idx]!, until);
      continue;
    }
    const duration =
      (row.line_count >= 3 || row.quantity_total >= 4
        ? params.settings.complexBaselineSeconds
        : params.settings.simpleBaselineSeconds) * 1000;
    const idx = pickLane();
    const start = Math.max(now.getTime(), lanes[idx]!);
    let ready = Math.max(start + duration, now.getTime() + params.settings.minPrepMinutes * 60_000);
    ready = Math.ceil(ready / (5 * 60_000)) * (5 * 60_000);
    lanes[idx] = ready;
    const previous = row.current_estimated_ready_at?.getTime() ?? 0;
    if (Math.abs(ready - previous) > 60_000) {
      await db.query(`UPDATE orders SET current_estimated_ready_at = $2 WHERE id = $1`, [
        row.id,
        new Date(ready),
      ]);
      updated++;
    }
  }
  return updated;
}

export function speakEta(readyAt: Date, now: Date = new Date()): string {
  const minutes = Math.max(5, Math.round((readyAt.getTime() - now.getTime()) / 60_000));
  return `about ${minutes} minutes`;
}
