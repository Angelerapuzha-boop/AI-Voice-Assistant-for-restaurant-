import crypto from "node:crypto";
import type pg from "pg";
import type { Queryable } from "../db/client";
import { camelRow, camelRows } from "../types";
import type { Restaurant } from "../types";
import { enqueueNotification } from "./notifications";
import { isUsablePhone } from "./customers";
import { restockInventory, stockStatus } from "./inventory";
import { auditLog } from "./audit";

/**
 * Suppliers + automatic stock replacement. The maintenance worker sweeps
 * low stock: items with a supplier and auto-replenish on get ONE open
 * replenishment request — supplier SMS with a secure confirm link, and
 * optionally an automated voice call (placed by the caller the worker
 * injects). The supplier answers on a public page; the owner marks the
 * delivery received, which restocks the item.
 */

export interface SupplierRow {
  id: string;
  restaurantId: string;
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
  smsEnabled: boolean;
  callEnabled: boolean;
  active: boolean;
}

export interface ReplenishmentRow {
  id: string;
  restaurantId: string;
  supplierId: string;
  inventoryItemId: string;
  qty: number;
  unit: string;
  status: "requested" | "confirmed" | "declined" | "received" | "cancelled";
  requestedAt: Date;
  respondedAt: Date | null;
  receivedAt: Date | null;
  note: string;
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function listSuppliers(db: Queryable, restaurantId: string): Promise<SupplierRow[]> {
  const res = await db.query(
    `SELECT * FROM suppliers WHERE restaurant_id = $1 AND active ORDER BY name`,
    [restaurantId],
  );
  return camelRows<SupplierRow>(res.rows);
}

export async function createSupplier(
  db: Queryable,
  params: {
    restaurantId: string;
    name: string;
    contactName?: string;
    phone?: string;
    email?: string;
    notes?: string;
    smsEnabled?: boolean;
    callEnabled?: boolean;
  },
): Promise<SupplierRow> {
  const res = await db.query(
    `INSERT INTO suppliers (restaurant_id, name, contact_name, phone, email, notes, sms_enabled, call_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (restaurant_id, name) DO UPDATE SET active = true, updated_at = now()
     RETURNING *`,
    [
      params.restaurantId,
      params.name.trim(),
      params.contactName ?? "",
      params.phone ?? "",
      params.email ?? "",
      params.notes ?? "",
      params.smsEnabled ?? true,
      params.callEnabled ?? false,
    ],
  );
  return camelRow<SupplierRow>(res.rows[0] as Record<string, unknown>);
}

export async function updateSupplier(
  db: Queryable,
  supplierId: string,
  patch: Partial<Pick<SupplierRow, "name" | "contactName" | "phone" | "email" | "notes" | "smsEnabled" | "callEnabled" | "active">>,
): Promise<SupplierRow | null> {
  const cols: Record<string, string> = {
    name: "name",
    contactName: "contact_name",
    phone: "phone",
    email: "email",
    notes: "notes",
    smsEnabled: "sms_enabled",
    callEnabled: "call_enabled",
    active: "active",
  };
  const sets: string[] = ["updated_at = now()"];
  const values: unknown[] = [supplierId];
  for (const [key, col] of Object.entries(cols)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    }
  }
  const res = await db.query(`UPDATE suppliers SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
  return res.rows[0] ? camelRow<SupplierRow>(res.rows[0] as Record<string, unknown>) : null;
}

/** Assign a supplier / auto-replenish flag to a stock line. */
export async function assignSupplierToItem(
  db: Queryable,
  params: { itemId: string; supplierId: string | null; autoReplenish?: boolean },
): Promise<void> {
  await db.query(
    `UPDATE inventory_items SET supplier_id = $2,
       auto_replenish = COALESCE($3, auto_replenish), updated_at = now()
     WHERE id = $1`,
    [params.itemId, params.supplierId, params.autoReplenish ?? null],
  );
}

export interface ReplenishmentDetail extends ReplenishmentRow {
  supplierName: string;
  supplierPhone: string;
  itemName: string;
}

export async function listReplenishments(
  db: Queryable,
  restaurantId: string,
  limit = 30,
): Promise<ReplenishmentDetail[]> {
  const res = await db.query(
    `SELECT r.*, s.name AS supplier_name, s.phone AS supplier_phone, ii.name AS item_name
     FROM replenishment_orders r
     JOIN suppliers s ON s.id = r.supplier_id
     JOIN inventory_items ii ON ii.id = r.inventory_item_id
     WHERE r.restaurant_id = $1 ORDER BY r.requested_at DESC LIMIT $2`,
    [restaurantId, limit],
  );
  return camelRows<ReplenishmentDetail>(res.rows).map((r) => ({ ...r, qty: Number(r.qty) }));
}

export interface PlacedCall {
  supplierPhone: string;
  script: string;
}

/**
 * Auto-replacement sweep: every low/out stock line with a supplier and
 * auto-replenish on gets ONE open request (dedup on open status). Sends
 * the supplier SMS and returns voice-call jobs for call-enabled
 * suppliers — the worker decides how to place them.
 */
export async function sweepAutoReplenishment(
  db: pg.Pool,
  params: { restaurant: Restaurant; appUrl: string },
): Promise<{ created: number; calls: PlacedCall[] }> {
  const { restaurant } = params;
  const due = await db.query(
    `SELECT ii.*, s.name AS s_name, s.phone AS s_phone, s.sms_enabled AS s_sms, s.call_enabled AS s_call,
            s.contact_name AS s_contact
     FROM inventory_items ii
     JOIN suppliers s ON s.id = ii.supplier_id AND s.active
     WHERE ii.restaurant_id = $1 AND ii.active AND ii.auto_replenish
       AND ii.current_qty <= ii.reorder_level
       AND NOT EXISTS (
         SELECT 1 FROM replenishment_orders r
         WHERE r.inventory_item_id = ii.id AND r.status IN ('requested', 'confirmed'))`,
    [restaurant.id],
  );

  let created = 0;
  const calls: PlacedCall[] = [];
  for (const raw of due.rows as Record<string, unknown>[]) {
    const item = {
      id: String(raw.id),
      name: String(raw.name),
      unit: String(raw.unit),
      currentQty: Number(raw.current_qty),
      reorderLevel: Number(raw.reorder_level),
      parLevel: Number(raw.par_level),
      supplierId: String(raw.supplier_id),
    };
    const qty = Math.max(1, Math.ceil(item.parLevel - item.currentQty));
    const token = crypto.randomBytes(24).toString("base64url");
    await db.query(
      `INSERT INTO replenishment_orders (restaurant_id, supplier_id, inventory_item_id, qty, unit, token_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [restaurant.id, item.supplierId, item.id, qty, item.unit, hashToken(token)],
    );
    created++;
    const link = `${params.appUrl.replace(/\/$/, "")}/supply/${token}`;
    const supplierPhone = String(raw.s_phone ?? "");
    const status = stockStatus(item);
    if (Boolean(raw.s_sms) && isUsablePhone(supplierPhone)) {
      await enqueueNotification(db, {
        orderId: null,
        kind: "supplier_sms",
        toNumber: supplierPhone,
        body:
          `${restaurant.name} stock order: ${qty} ${item.unit} of ${item.name}` +
          `${status === "out" ? " (we are OUT)" : ""}. ` +
          `Please confirm or decline: ${link}`,
      });
    }
    if (Boolean(raw.s_call) && isUsablePhone(supplierPhone)) {
      calls.push({
        supplierPhone,
        script:
          `Hello${raw.s_contact ? ` ${String(raw.s_contact)}` : ""}. This is an automated stock order from ${restaurant.name}. ` +
          `We would like to order ${qty} ${item.unit} of ${item.name}. ` +
          `We have also sent you an S M S with a link to confirm the order. Thank you.`,
      });
    }
    await auditLog(db, {
      restaurantId: restaurant.id,
      actor: "ai",
      action: "supplier.replenishment_requested",
      entityType: "inventory_item",
      entityId: item.id,
      changes: { qty, supplier: String(raw.s_name) },
    });
  }
  return { created, calls };
}

/** Supplier's answer from the public /supply/<token> page. */
export async function respondReplenishment(
  db: Queryable,
  token: string,
  action: "confirmed" | "declined",
): Promise<ReplenishmentDetail | null> {
  const res = await db.query(
    `UPDATE replenishment_orders SET status = $2, responded_at = now()
     WHERE token_hash = $1 AND status = 'requested' RETURNING id, restaurant_id`,
    [hashToken(token), action],
  );
  if (!res.rows[0]) return null;
  const row = res.rows[0] as { id: string; restaurant_id: string };
  const detail = await listReplenishments(db, row.restaurant_id, 200);
  return detail.find((d) => d.id === row.id) ?? null;
}

export async function getReplenishmentByToken(
  db: Queryable,
  token: string,
): Promise<(ReplenishmentDetail & { restaurantName: string }) | null> {
  const res = await db.query(
    `SELECT r.*, s.name AS supplier_name, s.phone AS supplier_phone, ii.name AS item_name,
            rest.name AS restaurant_name
     FROM replenishment_orders r
     JOIN suppliers s ON s.id = r.supplier_id
     JOIN inventory_items ii ON ii.id = r.inventory_item_id
     JOIN restaurants rest ON rest.id = r.restaurant_id
     WHERE r.token_hash = $1`,
    [hashToken(token)],
  );
  if (!res.rows[0]) return null;
  const row = camelRow<ReplenishmentDetail & { restaurantName: string }>(
    res.rows[0] as Record<string, unknown>,
  );
  return { ...row, qty: Number(row.qty) };
}

/** Goods arrived: mark received and put the stock back on the shelf. */
export async function receiveReplenishment(
  db: Queryable,
  replenishmentId: string,
  actor: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE replenishment_orders SET status = 'received', received_at = now()
     WHERE id = $1 AND status IN ('requested', 'confirmed')
     RETURNING inventory_item_id, qty, restaurant_id`,
    [replenishmentId],
  );
  if (!res.rows[0]) return false;
  const row = res.rows[0] as { inventory_item_id: string; qty: string; restaurant_id: string };
  await restockInventory(db, {
    itemId: row.inventory_item_id,
    qty: Number(row.qty),
    actor,
    note: "supplier delivery received",
  });
  await auditLog(db, {
    restaurantId: row.restaurant_id,
    actor,
    action: "supplier.replenishment_received",
    entityType: "replenishment_order",
    entityId: replenishmentId,
    changes: { qty: Number(row.qty) },
  });
  return true;
}

export async function cancelReplenishment(db: Queryable, replenishmentId: string): Promise<void> {
  await db.query(
    `UPDATE replenishment_orders SET status = 'cancelled' WHERE id = $1 AND status IN ('requested', 'confirmed')`,
    [replenishmentId],
  );
}
