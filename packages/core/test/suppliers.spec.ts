import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assignSupplierToItem,
  closeDb,
  createSupplier,
  env,
  getDb,
  getDefaultRestaurant,
  getReplenishmentByToken,
  listInventory,
  listReplenishments,
  receiveReplenishment,
  respondReplenishment,
  runMigrations,
  seed,
  sweepAutoReplenishment,
  type Restaurant,
} from "../src";

let restaurant: Restaurant;
let supplierId = "";
let itemId = "";

beforeAll(async () => {
  (env as { DATABASE_URL: string }).DATABASE_URL = env.TEST_DATABASE_URL;
  const db = getDb();
  await runMigrations(db);
  await seed(db);
  restaurant = await getDefaultRestaurant(db);
});

beforeEach(async () => {
  const db = getDb();
  await db.query(`TRUNCATE replenishment_orders, notification_attempts CASCADE`);
  await db.query(`DELETE FROM suppliers`);
  const supplier = await createSupplier(db, {
    restaurantId: restaurant.id,
    name: "Perth Poultry Co",
    phone: "+61455111222",
    callEnabled: true,
  });
  supplierId = supplier.id;
  const items = await listInventory(db, restaurant.id, "raw");
  itemId = items.find((i) => i.name === "Chicken (raw)")!.id;
  await db.query(
    `UPDATE inventory_items SET current_qty = 5, reorder_level = 10, par_level = 40,
       supplier_id = NULL, auto_replenish = false WHERE restaurant_id = $1`,
    [restaurant.id],
  );
  await assignSupplierToItem(db, { itemId, supplierId, autoReplenish: true });
});

afterAll(async () => {
  await closeDb();
});

describe("automatic stock replacement", () => {
  it("raises ONE supplier request with SMS and call job when stock is low", async () => {
    const db = getDb();
    const result = await sweepAutoReplenishment(db, { restaurant, appUrl: "https://x.test" });
    expect(result.created).toBe(1);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.supplierPhone).toBe("+61455111222");
    expect(result.calls[0]!.script).toContain("35 kg of Chicken (raw)");
    const sms = await db.query(`SELECT to_number, body FROM notification_attempts WHERE kind = 'supplier_sms'`);
    expect(sms.rows).toHaveLength(1);
    expect((sms.rows[0] as { body: string }).body).toContain("https://x.test/supply/");
    // Second sweep: open request exists — no duplicates.
    const again = await sweepAutoReplenishment(db, { restaurant, appUrl: "https://x.test" });
    expect(again.created).toBe(0);
  });

  it("supplier confirms via token; owner receives goods and stock returns", async () => {
    const db = getDb();
    await sweepAutoReplenishment(db, { restaurant, appUrl: "https://x.test" });
    const sms = await db.query(`SELECT body FROM notification_attempts WHERE kind = 'supplier_sms'`);
    const token = (sms.rows[0] as { body: string }).body.match(/\/supply\/([A-Za-z0-9_-]+)/)![1]!;

    const view = await getReplenishmentByToken(db, token);
    expect(view).toMatchObject({ itemName: "Chicken (raw)", qty: 35, status: "requested" });

    const confirmed = await respondReplenishment(db, token, "confirmed");
    expect(confirmed?.status).toBe("confirmed");
    // Re-answering is refused.
    expect(await respondReplenishment(db, token, "declined")).toBeNull();

    const [order] = await listReplenishments(db, restaurant.id);
    expect(await receiveReplenishment(db, order!.id, "owner@test")).toBe(true);
    const items = await listInventory(db, restaurant.id, "raw");
    expect(items.find((i) => i.id === itemId)!.currentQty).toBe(40); // 5 + 35
  });

  it("does nothing without auto-replenish or when stocked", async () => {
    const db = getDb();
    await assignSupplierToItem(db, { itemId, supplierId, autoReplenish: false });
    expect((await sweepAutoReplenishment(db, { restaurant, appUrl: "https://x.test" })).created).toBe(0);
    await assignSupplierToItem(db, { itemId, supplierId, autoReplenish: true });
    await db.query(`UPDATE inventory_items SET current_qty = 40 WHERE id = $1`, [itemId]);
    expect((await sweepAutoReplenishment(db, { restaurant, appUrl: "https://x.test" })).created).toBe(0);
  });
});
