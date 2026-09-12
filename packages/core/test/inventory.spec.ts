import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addOrderItem,
  adjustInventory,
  cancelOrder,
  closeDb,
  confirmOrder,
  createDraft,
  env,
  getDb,
  getDefaultRestaurant,
  listInventory,
  lowStockItems,
  restockInventory,
  runMigrations,
  seed,
  stockStatus,
} from "../src";

let restaurantId = "";
let chickenId = "";
let baseModId = "";
let chickenStockId = "";

async function stockOf(name: string): Promise<number> {
  const items = await listInventory(getDb(), restaurantId);
  return items.find((i) => i.name === name)!.currentQty;
}

async function confirmedOrder(quantity = 1): Promise<string> {
  const db = getDb();
  const draft = await createDraft(db, {
    restaurantId,
    customerName: "Stock Test",
    orderType: "takeaway",
    source: "phone",
  });
  await addOrderItem(db, {
    orderId: draft.id,
    menuItemId: chickenId,
    quantity,
    modifierIds: [baseModId],
    removals: [],
  });
  const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
  return order.id;
}

beforeAll(async () => {
  (env as { DATABASE_URL: string }).DATABASE_URL = env.TEST_DATABASE_URL;
  const db = getDb();
  await runMigrations(db);
  await seed(db);
  restaurantId = (await getDefaultRestaurant(db)).id;
  const item = await db.query(`SELECT id FROM menu_items WHERE name = 'Chicken Meatbox'`);
  chickenId = (item.rows[0] as { id: string }).id;
  const mod = await db.query(
    `SELECT m.id FROM menu_item_modifiers m
     JOIN menu_item_modifier_groups g ON g.id = m.group_id
     WHERE g.menu_item_id = $1 AND m.name = 'Chips & Salad'`,
    [chickenId],
  );
  baseModId = (mod.rows[0] as { id: string }).id;
});

beforeEach(async () => {
  const db = getDb();
  await db.query(
    `TRUNCATE inventory_movements, order_item_modifiers, order_items, notification_attempts, call_events, orders CASCADE`,
  );
  // Reset the chicken stock line to a known state.
  await db.query(
    `UPDATE inventory_items SET current_qty = 50, reorder_level = 10, par_level = 50
     WHERE restaurant_id = $1 AND name = 'Chicken Meatbox'`,
    [restaurantId],
  );
  const row = await db.query(
    `SELECT id FROM inventory_items WHERE restaurant_id = $1 AND name = 'Chicken Meatbox'`,
    [restaurantId],
  );
  chickenStockId = (row.rows[0] as { id: string }).id;
});

afterAll(async () => {
  await closeDb();
});

describe("inventory lifecycle", () => {
  it("seeds a stock line per active menu item", async () => {
    const items = await listInventory(getDb(), restaurantId);
    expect(items.length).toBeGreaterThan(10);
    expect(items.some((i) => i.name === "Chicken Meatbox")).toBe(true);
  });

  it("confirming an order depletes stock and logs a movement", async () => {
    const orderId = await confirmedOrder(3);
    expect(await stockOf("Chicken Meatbox")).toBe(47);
    const moves = await getDb().query(
      `SELECT delta, reason FROM inventory_movements WHERE order_id = $1`,
      [orderId],
    );
    expect(moves.rows).toEqual([{ delta: "-3.00", reason: "order" }]);
  });

  it("cancelling a confirmed order restores stock exactly once", async () => {
    const orderId = await confirmedOrder(2);
    expect(await stockOf("Chicken Meatbox")).toBe(48);
    await cancelOrder(getDb(), orderId, "test", "changed mind");
    expect(await stockOf("Chicken Meatbox")).toBe(50);
    // A second restore attempt must be a no-op (idempotent).
    const { restoreInventoryForOrder } = await import("../src/domain/inventory");
    await restoreInventoryForOrder(getDb(), orderId);
    expect(await stockOf("Chicken Meatbox")).toBe(50);
  });

  it("cancelling a draft does not touch stock", async () => {
    const db = getDb();
    const draft = await createDraft(db, { restaurantId, orderType: "takeaway", source: "phone" });
    await addOrderItem(db, {
      orderId: draft.id,
      menuItemId: chickenId,
      quantity: 5,
      modifierIds: [baseModId],
      removals: [],
    });
    await cancelOrder(db, draft.id, "test");
    expect(await stockOf("Chicken Meatbox")).toBe(50);
  });

  it("low stock detection and restock to par", async () => {
    await adjustInventory(getDb(), { itemId: chickenStockId, newQty: 4, actor: "test" });
    const low = await lowStockItems(getDb(), restaurantId);
    expect(low.some((i) => i.id === chickenStockId)).toBe(true);
    expect(stockStatus({ currentQty: 4, reorderLevel: 10 })).toBe("low");
    expect(stockStatus({ currentQty: 0, reorderLevel: 10 })).toBe("out");
    const after = await restockInventory(getDb(), { itemId: chickenStockId, actor: "test" });
    expect(after!.currentQty).toBe(50); // topped up to par
    const lowAfter = await lowStockItems(getDb(), restaurantId);
    expect(lowAfter.some((i) => i.id === chickenStockId)).toBe(false);
  });
});
