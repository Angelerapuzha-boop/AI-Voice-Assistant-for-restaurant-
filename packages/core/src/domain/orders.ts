import type pg from "pg";
import { withTransaction, type Queryable } from "../db/client";
import { formatCents } from "../money";
import {
  camelRow,
  camelRows,
  type Order,
  type OrderItem,
  type OrderItemModifier,
  type OrderStatus,
  type OrderType,
  type OrderWithItems,
} from "../types";
import { getItem, getModifierGroups } from "./menu";
import { priceLine, priceOrder } from "./pricing";
import { getSpecial, isSpecialOrderable } from "./specials";
import { auditLog } from "./audit";
import { enqueueWebhookEvent } from "./webhooks";

/** Validation failure whose message is safe to read to the caller. */
export class OrderValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrderValidationError";
  }
}

const ACTIVE_KITCHEN_STATUSES: OrderStatus[] = ["new", "accepted", "preparing", "ready"];

// ---------------------------------------------------------------- reads

export async function getOrder(db: Queryable, orderId: string): Promise<Order | null> {
  const res = await db.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  return res.rows[0] ? camelRow<Order>(res.rows[0]) : null;
}

export async function getOrderWithItems(
  db: Queryable,
  orderId: string,
): Promise<OrderWithItems | null> {
  const order = await getOrder(db, orderId);
  if (!order) return null;
  const itemsRes = await db.query(
    `SELECT * FROM order_items WHERE order_id = $1 ORDER BY sort_order, id`,
    [orderId],
  );
  const items = camelRows<Omit<OrderItem, "modifiers">>(itemsRes.rows);
  const modsRes = await db.query(
    `SELECT oim.* FROM order_item_modifiers oim
     JOIN order_items oi ON oi.id = oim.order_item_id
     WHERE oi.order_id = $1 ORDER BY oim.id`,
    [orderId],
  );
  const mods = camelRows<OrderItemModifier>(modsRes.rows);
  return {
    ...order,
    items: items.map((i) => ({ ...i, modifiers: mods.filter((m) => m.orderItemId === i.id) })),
  };
}

// ---------------------------------------------------------------- drafts

export async function createDraft(
  db: Queryable,
  params: {
    restaurantId: string;
    customerPhone?: string;
    customerName?: string;
    orderType?: OrderType;
    callId?: string;
    source?: "phone" | "pos" | "web";
  },
): Promise<Order> {
  const res = await db.query(
    `INSERT INTO orders (restaurant_id, customer_phone, customer_name, order_type, call_id, status, source)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6) RETURNING *`,
    [
      params.restaurantId,
      params.customerPhone ?? "",
      params.customerName ?? "",
      params.orderType ?? "takeaway",
      params.callId ?? null,
      params.source ?? "phone",
    ],
  );
  return camelRow<Order>(res.rows[0] as Record<string, unknown>);
}

async function assertMutable(db: Queryable, orderId: string): Promise<Order> {
  const order = await getOrder(db, orderId);
  if (!order) throw new OrderValidationError("ORDER_NOT_FOUND", "That order no longer exists.");
  if (order.status !== "draft") {
    throw new OrderValidationError(
      "ORDER_NOT_DRAFT",
      `This order has already been ${order.status === "new" ? "confirmed" : order.status} and can't be changed here.`,
    );
  }
  return order;
}

// ---------------------------------------------------------------- item mutation

export interface AddItemParams {
  orderId: string;
  menuItemId?: string;
  specialId?: string;
  quantity: number;
  modifierIds?: string[];
  removals?: string[];
  specialInstructions?: string;
}

async function validateMenuItemSelection(
  db: Queryable,
  menuItemId: string,
  modifierIds: string[],
): Promise<{
  name: string;
  unitPriceCents: number;
  modifiers: { modifierId: string; groupName: string; name: string; priceCents: number }[];
}> {
  const item = await getItem(db, menuItemId);
  if (!item || !item.active) {
    throw new OrderValidationError("ITEM_NOT_FOUND", "That item isn't on our menu.");
  }
  if (!item.isAvailable || item.isSoldOut) {
    throw new OrderValidationError(
      "ITEM_UNAVAILABLE",
      `Sorry, ${item.name} is not available right now.`,
    );
  }
  const groups = await getModifierGroups(db, menuItemId);
  const modifierById = new Map(
    groups.flatMap((g) => g.modifiers.map((m) => [m.id, { group: g, modifier: m }] as const)),
  );

  const chosen: { modifierId: string; groupName: string; name: string; priceCents: number }[] = [];
  const countPerGroup = new Map<string, number>();
  for (const id of modifierIds) {
    const found = modifierById.get(id);
    if (!found) {
      throw new OrderValidationError(
        "MODIFIER_INVALID",
        `That option isn't available for ${item.name}.`,
      );
    }
    if (!found.modifier.isAvailable) {
      throw new OrderValidationError(
        "MODIFIER_UNAVAILABLE",
        `Sorry, ${found.modifier.name} is not available right now.`,
      );
    }
    countPerGroup.set(found.group.id, (countPerGroup.get(found.group.id) ?? 0) + 1);
    chosen.push({
      modifierId: id,
      groupName: found.group.name,
      name: found.modifier.name,
      priceCents: found.modifier.priceCents,
    });
  }

  for (const group of groups) {
    const count = countPerGroup.get(group.id) ?? 0;
    const minimum = group.required ? Math.max(1, group.minSelect) : group.minSelect;
    if (count < minimum) {
      const options = group.modifiers
        .filter((m) => m.isAvailable)
        .map((m) => m.name)
        .join(", ");
      throw new OrderValidationError(
        "MODIFIER_REQUIRED",
        `${item.name} needs a ${group.name} selection. Options: ${options}.`,
      );
    }
    if (count > group.maxSelect) {
      throw new OrderValidationError(
        "MODIFIER_TOO_MANY",
        `You can pick at most ${group.maxSelect} ${group.name} option${group.maxSelect === 1 ? "" : "s"} for ${item.name}.`,
      );
    }
  }

  return { name: item.name, unitPriceCents: item.priceCents, modifiers: chosen };
}

export async function addOrderItem(db: pg.Pool, params: AddItemParams): Promise<OrderWithItems> {
  return withTransaction(db, async (tx) => {
    const order = await assertMutable(tx, params.orderId);
    if (!Number.isInteger(params.quantity) || params.quantity < 1 || params.quantity > 50) {
      throw new OrderValidationError("BAD_QUANTITY", "Quantity must be between 1 and 50.");
    }
    if (!params.menuItemId === !params.specialId) {
      throw new OrderValidationError(
        "BAD_ITEM_REF",
        "Exactly one of menuItemId or specialId is required.",
      );
    }

    let name: string;
    let unitPriceCents: number;
    let modifiers: { modifierId: string | null; groupName: string; name: string; priceCents: number }[] =
      [];

    if (params.menuItemId) {
      const validated = await validateMenuItemSelection(
        tx,
        params.menuItemId,
        params.modifierIds ?? [],
      );
      name = validated.name;
      unitPriceCents = validated.unitPriceCents;
      modifiers = validated.modifiers;
    } else {
      const special = await getSpecial(tx, params.specialId!);
      if (!special || !isSpecialOrderable(special)) {
        throw new OrderValidationError(
          "SPECIAL_UNAVAILABLE",
          "That special isn't available right now.",
        );
      }
      if ((params.modifierIds ?? []).length > 0) {
        throw new OrderValidationError(
          "SPECIAL_NO_MODIFIERS",
          "Specials come as described and can't be modified. Special requests can be added as instructions.",
        );
      }
      name = special.name;
      unitPriceCents = special.priceCents;
    }

    const line = priceLine({
      unitPriceCents,
      quantity: params.quantity,
      modifiers,
    });

    const sortRes = await tx.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM order_items WHERE order_id = $1`,
      [params.orderId],
    );
    const itemRes = await tx.query(
      `INSERT INTO order_items
        (order_id, menu_item_id, special_id, name_snapshot, unit_price_cents, quantity,
         special_instructions, removals, line_total_cents, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        params.orderId,
        params.menuItemId ?? null,
        params.specialId ?? null,
        name,
        unitPriceCents,
        params.quantity,
        params.specialInstructions ?? "",
        params.removals ?? [],
        line.lineTotalCents,
        (sortRes.rows[0] as { next: number }).next,
      ],
    );
    const orderItemId = (itemRes.rows[0] as { id: string }).id;
    for (const mod of modifiers) {
      await tx.query(
        `INSERT INTO order_item_modifiers
          (order_item_id, modifier_id, group_name_snapshot, name_snapshot, price_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderItemId, mod.modifierId, mod.groupName, mod.name, mod.priceCents],
      );
    }
    await recalcOrderTx(tx, order.id);
    return (await getOrderWithItems(tx, order.id))!;
  });
}

export interface UpdateItemParams {
  orderId: string;
  orderItemId: string;
  quantity?: number;
  modifierIds?: string[]; // full replacement when provided
  removals?: string[];
  specialInstructions?: string;
}

export async function updateOrderItem(
  db: pg.Pool,
  params: UpdateItemParams,
): Promise<OrderWithItems> {
  return withTransaction(db, async (tx) => {
    const order = await assertMutable(tx, params.orderId);
    const existingRes = await tx.query(
      `SELECT * FROM order_items WHERE id = $1 AND order_id = $2`,
      [params.orderItemId, params.orderId],
    );
    if (!existingRes.rows[0]) {
      throw new OrderValidationError("LINE_NOT_FOUND", "That item isn't in the order.");
    }
    const existing = camelRow<Omit<OrderItem, "modifiers">>(existingRes.rows[0]);

    const quantity = params.quantity ?? existing.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new OrderValidationError("BAD_QUANTITY", "Quantity must be between 1 and 50.");
    }

    let modifiers: { modifierId: string | null; groupName: string; name: string; priceCents: number }[];
    if (params.modifierIds !== undefined) {
      if (!existing.menuItemId) {
        throw new OrderValidationError("SPECIAL_NO_MODIFIERS", "Specials can't be modified.");
      }
      const validated = await validateMenuItemSelection(tx, existing.menuItemId, params.modifierIds);
      modifiers = validated.modifiers;
      await tx.query(`DELETE FROM order_item_modifiers WHERE order_item_id = $1`, [
        params.orderItemId,
      ]);
      for (const mod of modifiers) {
        await tx.query(
          `INSERT INTO order_item_modifiers
            (order_item_id, modifier_id, group_name_snapshot, name_snapshot, price_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [params.orderItemId, mod.modifierId, mod.groupName, mod.name, mod.priceCents],
        );
      }
    } else {
      const modsRes = await tx.query(
        `SELECT * FROM order_item_modifiers WHERE order_item_id = $1`,
        [params.orderItemId],
      );
      modifiers = camelRows<OrderItemModifier>(modsRes.rows).map((m) => ({
        modifierId: m.modifierId,
        groupName: m.groupNameSnapshot,
        name: m.nameSnapshot,
        priceCents: m.priceCents,
      }));
    }

    const line = priceLine({ unitPriceCents: existing.unitPriceCents, quantity, modifiers });
    await tx.query(
      `UPDATE order_items
       SET quantity = $2,
           removals = COALESCE($3, removals),
           special_instructions = COALESCE($4, special_instructions),
           line_total_cents = $5
       WHERE id = $1`,
      [
        params.orderItemId,
        quantity,
        params.removals ?? null,
        params.specialInstructions ?? null,
        line.lineTotalCents,
      ],
    );
    await recalcOrderTx(tx, order.id);
    return (await getOrderWithItems(tx, order.id))!;
  });
}

export async function removeOrderItem(
  db: pg.Pool,
  orderId: string,
  orderItemId: string,
): Promise<OrderWithItems> {
  return withTransaction(db, async (tx) => {
    const order = await assertMutable(tx, orderId);
    const res = await tx.query(`DELETE FROM order_items WHERE id = $1 AND order_id = $2`, [
      orderItemId,
      orderId,
    ]);
    if (res.rowCount === 0) {
      throw new OrderValidationError("LINE_NOT_FOUND", "That item isn't in the order.");
    }
    await recalcOrderTx(tx, order.id);
    return (await getOrderWithItems(tx, order.id))!;
  });
}

async function recalcOrderTx(tx: Queryable, orderId: string): Promise<void> {
  const itemsRes = await tx.query(
    `SELECT oi.id, oi.unit_price_cents, oi.quantity,
            COALESCE(json_agg(json_build_object('priceCents', oim.price_cents))
              FILTER (WHERE oim.id IS NOT NULL), '[]') AS mods
     FROM order_items oi
     LEFT JOIN order_item_modifiers oim ON oim.order_item_id = oi.id
     WHERE oi.order_id = $1
     GROUP BY oi.id`,
    [orderId],
  );
  const orderRes = await tx.query(`SELECT discount_cents FROM orders WHERE id = $1`, [orderId]);
  const discount = (orderRes.rows[0] as { discount_cents: number }).discount_cents;
  const totals = priceOrder(
    itemsRes.rows.map((r: Record<string, unknown>) => ({
      unitPriceCents: r.unit_price_cents as number,
      quantity: r.quantity as number,
      modifiers: r.mods as { priceCents: number }[],
    })),
    discount,
  );
  await tx.query(
    `UPDATE orders SET subtotal_cents = $2, discount_cents = $3, total_cents = $4, updated_at = now()
     WHERE id = $1`,
    [orderId, totals.subtotalCents, totals.discountCents, totals.totalCents],
  );
}

// ---------------------------------------------------------------- details

export async function setOrderDetails(
  db: pg.Pool,
  params: {
    orderId: string;
    customerName?: string;
    customerPhone?: string;
    orderType?: OrderType;
    requestedAsap?: boolean;
    requestedTime?: Date | null;
    customerNotes?: string;
    allergyNotes?: string;
  },
): Promise<Order> {
  return withTransaction(db, async (tx) => {
    await assertMutable(tx, params.orderId);
    const res = await tx.query(
      `UPDATE orders SET
         customer_name = COALESCE($2, customer_name),
         customer_phone = COALESCE($3, customer_phone),
         order_type = COALESCE($4, order_type),
         requested_asap = COALESCE($5, requested_asap),
         requested_time = CASE WHEN $6 THEN $7 ELSE requested_time END,
         customer_notes = COALESCE($8, customer_notes),
         allergy_notes = COALESCE($9, allergy_notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        params.orderId,
        params.customerName ?? null,
        params.customerPhone ?? null,
        params.orderType ?? null,
        params.requestedAsap ?? null,
        params.requestedTime !== undefined,
        params.requestedTime ?? null,
        params.customerNotes ?? null,
        params.allergyNotes ?? null,
      ],
    );
    return camelRow<Order>(res.rows[0] as Record<string, unknown>);
  });
}

// ---------------------------------------------------------------- confirm / cancel

export async function confirmOrder(
  db: pg.Pool,
  params: {
    orderId: string;
    orderNumberPrefix: string;
    idempotencyKey?: string;
    actor?: string;
    /** Runs inside the confirmation transaction (e.g. enqueue owner SMS). */
    onConfirmed?: (tx: Queryable, order: OrderWithItems) => Promise<void>;
  },
): Promise<{ order: OrderWithItems; alreadyConfirmed: boolean }> {
  return withTransaction(db, async (tx) => {
    // Lock the order row to serialise concurrent confirmations (idempotency).
    const lockRes = await tx.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [
      params.orderId,
    ]);
    if (!lockRes.rows[0]) {
      throw new OrderValidationError("ORDER_NOT_FOUND", "That order no longer exists.");
    }
    const order = camelRow<Order>(lockRes.rows[0]);

    if (order.status !== "draft") {
      if (ACTIVE_KITCHEN_STATUSES.includes(order.status) || order.status === "completed") {
        // Duplicate confirm (e.g. reconnect after drop) — return existing, don't duplicate.
        return { order: (await getOrderWithItems(tx, order.id))!, alreadyConfirmed: true };
      }
      throw new OrderValidationError(
        "ORDER_NOT_DRAFT",
        `This order was ${order.status} and can't be confirmed.`,
      );
    }

    const itemsCount = await tx.query(`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1`, [
      params.orderId,
    ]);
    if ((itemsCount.rows[0] as { n: number }).n === 0) {
      throw new OrderValidationError("ORDER_EMPTY", "The order has no items yet.");
    }

    // Recheck at the moment of commitment (spec: availability and ordering
    // pause can change mid-call; commit must refuse, never silently accept).
    const pauseRes = await tx.query(
      `SELECT accepting_orders, pause_reason FROM restaurant_settings WHERE restaurant_id = $1`,
      [order.restaurantId],
    );
    const pause = pauseRes.rows[0] as
      | { accepting_orders: boolean; pause_reason: string }
      | undefined;
    if (pause && !pause.accepting_orders) {
      throw new OrderValidationError(
        "ORDERS_PAUSED",
        `We're not taking orders right now${pause.pause_reason ? ` — ${pause.pause_reason}` : ""}. Apologise and don't confirm.`,
      );
    }
    const unavailable = await tx.query(
      `SELECT DISTINCT mi.name FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
       WHERE oi.order_id = $1 AND (mi.is_sold_out OR NOT mi.is_available OR NOT mi.active)`,
      [params.orderId],
    );
    if (unavailable.rows.length > 0) {
      const names = unavailable.rows.map((r) => (r as { name: string }).name).join(", ");
      throw new OrderValidationError(
        "ITEM_UNAVAILABLE_AT_CONFIRM",
        `${names} just sold out — remove or replace it, re-read the order, then confirm.`,
      );
    }
    if (!order.customerName.trim()) {
      throw new OrderValidationError(
        "NAME_REQUIRED",
        "A customer name is needed before confirming. Ask for a name for the order.",
      );
    }

    await recalcOrderTx(tx, order.id);

    const seqRes = await tx.query(`SELECT nextval('order_number_seq') AS n`);
    const publicNumber = `${params.orderNumberPrefix}${(seqRes.rows[0] as { n: string }).n}`;

    await tx.query(
      `UPDATE orders SET
         status = 'new',
         public_order_number = $2,
         confirmed_at = now(),
         idempotency_key = COALESCE($3, idempotency_key),
         updated_at = now()
       WHERE id = $1`,
      [order.id, publicNumber, params.idempotencyKey ?? null],
    );
    // Increment special usage counters
    await tx.query(
      `UPDATE daily_specials ds SET quantity_used = ds.quantity_used + sub.qty
       FROM (SELECT special_id, SUM(quantity)::int AS qty FROM order_items
             WHERE order_id = $1 AND special_id IS NOT NULL GROUP BY special_id) sub
       WHERE ds.id = sub.special_id`,
      [order.id],
    );
    await auditLog(tx, {
      restaurantId: order.restaurantId,
      actor: params.actor ?? "ai",
      action: "order.confirmed",
      entityType: "order",
      entityId: order.id,
      changes: { publicOrderNumber: publicNumber },
    });
    const confirmed = (await getOrderWithItems(tx, order.id))!;
    if (params.onConfirmed) {
      await params.onConfirmed(tx, confirmed);
    }
    return { order: confirmed, alreadyConfirmed: false };
  });
}

export async function cancelOrder(
  db: pg.Pool,
  orderId: string,
  actor: string,
  reason = "",
): Promise<Order> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query(
      `UPDATE orders SET status = 'cancelled',
         internal_notes = internal_notes
           || CASE WHEN internal_notes = '' THEN '' ELSE E'\n' END
           || 'Cancelled by ' || $2 || CASE WHEN $3 = '' THEN '' ELSE ': ' || $3 END,
         updated_at = now()
       WHERE id = $1 AND status IN ('draft', 'new', 'accepted', 'preparing', 'ready', 'needs_review')
       RETURNING *`,
      [orderId, actor, reason],
    );
    if (!res.rows[0]) {
      throw new OrderValidationError(
        "CANNOT_CANCEL",
        "That order can't be cancelled at this stage.",
      );
    }
    await auditLog(tx, {
      actor,
      action: "order.cancelled",
      entityType: "order",
      entityId: orderId,
      changes: { reason },
    });
    return camelRow<Order>(res.rows[0] as Record<string, unknown>);
  });
}

export async function markNeedsReview(
  db: pg.Pool,
  orderId: string,
  note: string,
): Promise<Order | null> {
  const res = await db.query(
    `UPDATE orders SET status = 'needs_review',
       internal_notes = internal_notes || CASE WHEN internal_notes = '' THEN '' ELSE E'\n' END || $2,
       updated_at = now()
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [orderId, note],
  );
  if (!res.rows[0]) return null;
  const order = camelRow<Order>(res.rows[0]);
  await enqueueWebhookEvent(db, {
    event: "order.needs_review",
    orderId: order.id,
    payload: {
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      total: formatCents(order.totalCents),
      note,
    },
  });
  return order;
}

const STATUS_FLOW: Record<string, OrderStatus[]> = {
  new: ["accepted", "preparing", "ready", "cancelled"],
  accepted: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  needs_review: ["new", "cancelled"],
};

export async function updateOrderStatus(
  db: pg.Pool,
  orderId: string,
  next: OrderStatus,
  actor: string,
): Promise<Order> {
  return withTransaction(db, async (tx) => {
    const cur = await getOrder(tx, orderId);
    if (!cur) throw new OrderValidationError("ORDER_NOT_FOUND", "Order not found.");
    const allowed = STATUS_FLOW[cur.status] ?? [];
    if (!allowed.includes(next)) {
      throw new OrderValidationError(
        "BAD_STATUS_TRANSITION",
        `Can't move an order from ${cur.status} to ${next}.`,
      );
    }
    const res = await tx.query(
      `UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [orderId, next],
    );
    await auditLog(tx, {
      restaurantId: cur.restaurantId,
      actor,
      action: "order.status",
      entityType: "order",
      entityId: orderId,
      changes: { from: cur.status, to: next },
    });
    return camelRow<Order>(res.rows[0] as Record<string, unknown>);
  });
}

// ---------------------------------------------------------------- summary

export function describeOrderItems(order: OrderWithItems): string {
  return order.items
    .map((item) => {
      const parts = [`${item.quantity} x ${item.nameSnapshot}`];
      for (const mod of item.modifiers) {
        parts.push(
          `  - ${mod.nameSnapshot}${mod.priceCents > 0 ? ` (+${formatCents(mod.priceCents)})` : ""}`,
        );
      }
      for (const removal of item.removals) parts.push(`  - No ${removal}`);
      if (item.specialInstructions) parts.push(`  - Note: ${item.specialInstructions}`);
      return parts.join("\n");
    })
    .join("\n");
}

/** Spoken summary for the AI to read back before confirmation. */
export function speakableSummary(order: OrderWithItems): string {
  const lines = order.items.map((item) => {
    const bits: string[] = [];
    const mods = item.modifiers.map((m) => m.nameSnapshot);
    if (mods.length > 0) bits.push(`with ${mods.join(", ")}`);
    if (item.removals.length > 0) bits.push(`no ${item.removals.join(", no ")}`);
    if (item.specialInstructions) bits.push(`(${item.specialInstructions})`);
    return `${item.quantity} ${item.nameSnapshot}${bits.length ? " " + bits.join(", ") : ""}`;
  });
  const type = order.orderType === "takeaway" ? "takeaway" : "dine-in";
  const when = order.requestedAsap
    ? "as soon as possible"
    : order.requestedTime
      ? `for ${order.requestedTime.toISOString()}`
      : "";
  return `${lines.join("; ")}. ${type}${when ? ", " + when : ""}. Total ${formatCents(order.totalCents)}.`;
}

// ---------------------------------------------------------------- dashboard queries

export interface OrderSearchParams {
  restaurantId: string;
  q?: string; // order number / name / phone
  status?: OrderStatus | "active";
  orderType?: OrderType;
  todayOnly?: boolean;
  date?: string; // YYYY-MM-DD
  timezone?: string;
  limit?: number;
}

export async function searchOrders(db: Queryable, params: OrderSearchParams): Promise<Order[]> {
  const clauses = [`restaurant_id = $1`, `status <> 'draft'`];
  const values: unknown[] = [params.restaurantId];
  if (params.q) {
    values.push(`%${params.q}%`);
    clauses.push(
      `(public_order_number ILIKE $${values.length} OR customer_name ILIKE $${values.length} OR customer_phone ILIKE $${values.length})`,
    );
  }
  if (params.status === "active") {
    clauses.push(`status IN ('new', 'accepted', 'preparing', 'ready', 'needs_review')`);
  } else if (params.status) {
    values.push(params.status);
    clauses.push(`status = $${values.length}`);
  }
  if (params.orderType) {
    values.push(params.orderType);
    clauses.push(`order_type = $${values.length}`);
  }
  const tz = params.timezone ?? "Australia/Perth";
  if (params.todayOnly) {
    values.push(tz);
    clauses.push(`(created_at AT TIME ZONE $${values.length})::date = (now() AT TIME ZONE $${values.length})::date`);
  } else if (params.date) {
    values.push(tz);
    const tzIdx = values.length;
    values.push(params.date);
    clauses.push(`(created_at AT TIME ZONE $${tzIdx})::date = $${values.length}::date`);
  }
  values.push(params.limit ?? 100);
  const res = await db.query(
    `SELECT * FROM orders WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );
  return camelRows<Order>(res.rows);
}
