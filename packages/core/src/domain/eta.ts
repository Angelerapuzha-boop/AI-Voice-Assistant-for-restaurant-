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

export function speakEta(readyAt: Date, now: Date = new Date()): string {
  const minutes = Math.max(5, Math.round((readyAt.getTime() - now.getTime()) / 60_000));
  return `about ${minutes} minutes`;
}
