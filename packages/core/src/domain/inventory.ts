import type { Queryable } from "../db/client";
import { camelRows } from "../types";
import type { OrderWithItems } from "../types";

/**
 * Stock on hand. Confirmed orders deplete it inside the confirm
 * transaction; cancelling a confirmed order restores it. Depletion NEVER
 * blocks an order — running low raises alerts (Admin > Inventory and
 * Daily insights), the kitchen decides what to mark sold out.
 */

export interface InventoryItemRow {
  id: string;
  restaurantId: string;
  name: string;
  unit: string;
  currentQty: number;
  reorderLevel: number;
  parLevel: number;
  /** 'dish' auto-depletes with orders; 'raw' is the manual purchase list. */
  category: "dish" | "raw";
  active: boolean;
  updatedAt: Date;
}

export type StockStatus = "ok" | "low" | "out";

export function stockStatus(item: { currentQty: number; reorderLevel: number }): StockStatus {
  if (item.currentQty <= 0) return "out";
  if (item.currentQty <= item.reorderLevel) return "low";
  return "ok";
}

function numeric(row: Record<string, unknown>): InventoryItemRow {
  const r = camelRows<InventoryItemRow>([row])[0]!;
  return {
    ...r,
    currentQty: Number(r.currentQty),
    reorderLevel: Number(r.reorderLevel),
    parLevel: Number(r.parLevel),
  };
}

export async function listInventory(
  db: Queryable,
  restaurantId: string,
  category?: "dish" | "raw",
): Promise<InventoryItemRow[]> {
  const res = await db.query(
    `SELECT * FROM inventory_items
     WHERE restaurant_id = $1 AND active AND ($2::text IS NULL OR category = $2)
     ORDER BY name`,
    [restaurantId, category ?? null],
  );
  return (res.rows as Record<string, unknown>[]).map(numeric);
}

export async function lowStockItems(db: Queryable, restaurantId: string): Promise<InventoryItemRow[]> {
  const res = await db.query(
    `SELECT * FROM inventory_items
     WHERE restaurant_id = $1 AND active AND current_qty <= reorder_level
     ORDER BY current_qty / GREATEST(reorder_level, 1)`,
    [restaurantId],
  );
  return (res.rows as Record<string, unknown>[]).map(numeric);
}

/**
 * Deplete stock for every line of a confirmed order (same transaction as
 * the confirmation). Missing mappings are skipped; stock may go negative
 * (the alert, not a block, is the control).
 */
export async function consumeInventoryForOrder(tx: Queryable, order: OrderWithItems): Promise<void> {
  for (const line of order.items) {
    if (!line.menuItemId) continue; // specials have no mapping
    const mappings = await tx.query(
      `SELECT inventory_item_id, qty_per_unit FROM menu_item_ingredients WHERE menu_item_id = $1`,
      [line.menuItemId],
    );
    for (const m of mappings.rows as { inventory_item_id: string; qty_per_unit: string }[]) {
      const used = Number(m.qty_per_unit) * line.quantity;
      await tx.query(
        `UPDATE inventory_items SET current_qty = current_qty - $2, updated_at = now() WHERE id = $1`,
        [m.inventory_item_id, used],
      );
      await tx.query(
        `INSERT INTO inventory_movements (inventory_item_id, delta, reason, order_id)
         VALUES ($1, $2, 'order', $3)`,
        [m.inventory_item_id, -used, order.id],
      );
    }
  }
}

/** Reverse an order's depletion (cancellation of a confirmed order). Idempotent. */
export async function restoreInventoryForOrder(tx: Queryable, orderId: string): Promise<void> {
  const already = await tx.query(
    `SELECT 1 FROM inventory_movements WHERE order_id = $1 AND reason = 'order_cancelled' LIMIT 1`,
    [orderId],
  );
  if (already.rows.length > 0) return;
  const consumed = await tx.query(
    `SELECT inventory_item_id, SUM(delta) AS total FROM inventory_movements
     WHERE order_id = $1 AND reason = 'order' GROUP BY inventory_item_id`,
    [orderId],
  );
  for (const row of consumed.rows as { inventory_item_id: string; total: string }[]) {
    const back = -Number(row.total); // consumed deltas are negative
    if (back === 0) continue;
    await tx.query(
      `UPDATE inventory_items SET current_qty = current_qty + $2, updated_at = now() WHERE id = $1`,
      [row.inventory_item_id, back],
    );
    await tx.query(
      `INSERT INTO inventory_movements (inventory_item_id, delta, reason, order_id)
       VALUES ($1, $2, 'order_cancelled', $3)`,
      [row.inventory_item_id, back, orderId],
    );
  }
}

/** Add stock. qty omitted = top up to the par level. */
export async function restockInventory(
  db: Queryable,
  params: { itemId: string; qty?: number; actor: string; note?: string },
): Promise<InventoryItemRow | null> {
  const current = await db.query(`SELECT * FROM inventory_items WHERE id = $1`, [params.itemId]);
  if (!current.rows[0]) return null;
  const item = numeric(current.rows[0] as Record<string, unknown>);
  const qty = params.qty ?? Math.max(0, item.parLevel - item.currentQty);
  if (qty <= 0) return item;
  const res = await db.query(
    `UPDATE inventory_items SET current_qty = current_qty + $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [params.itemId, qty],
  );
  await db.query(
    `INSERT INTO inventory_movements (inventory_item_id, delta, reason, actor, note)
     VALUES ($1, $2, 'restock', $3, $4)`,
    [params.itemId, qty, params.actor, params.note ?? ""],
  );
  return numeric(res.rows[0] as Record<string, unknown>);
}

/** Set an absolute count (stocktake) or levels; movement records the correction. */
export async function adjustInventory(
  db: Queryable,
  params: { itemId: string; newQty?: number; reorderLevel?: number; parLevel?: number; actor: string; note?: string },
): Promise<InventoryItemRow | null> {
  const current = await db.query(`SELECT * FROM inventory_items WHERE id = $1`, [params.itemId]);
  if (!current.rows[0]) return null;
  const item = numeric(current.rows[0] as Record<string, unknown>);
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [params.itemId];
  if (params.newQty !== undefined) {
    values.push(params.newQty);
    sets.push(`current_qty = $${values.length}`);
  }
  if (params.reorderLevel !== undefined) {
    values.push(params.reorderLevel);
    sets.push(`reorder_level = $${values.length}`);
  }
  if (params.parLevel !== undefined) {
    values.push(params.parLevel);
    sets.push(`par_level = $${values.length}`);
  }
  const res = await db.query(
    `UPDATE inventory_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    values,
  );
  if (params.newQty !== undefined && params.newQty !== item.currentQty) {
    await db.query(
      `INSERT INTO inventory_movements (inventory_item_id, delta, reason, actor, note)
       VALUES ($1, $2, 'adjustment', $3, $4)`,
      [params.itemId, params.newQty - item.currentQty, params.actor, params.note ?? "stocktake"],
    );
  }
  return numeric(res.rows[0] as Record<string, unknown>);
}
