import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  addOrderItem,
  confirmOrder,
  createDraft,
  getOrderWithItems,
  OrderValidationError,
  removeOrderItem,
  setOrderDetails,
  updateOrderItem,
  updateOrderStatus,
} from "../src/domain/orders";
import { searchMenu } from "../src/domain/menu";
import {
  findItemByName,
  modifierId,
  resetTransactionalData,
  setupTestDb,
  type TestContext,
} from "./helpers";

let ctx: TestContext;
let db: pg.Pool;

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
  await db.query(`UPDATE menu_items SET is_sold_out = false, is_available = true`);
});

async function draftWithChickenMeatbox() {
  const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "Test" });
  const item = await findItemByName(db, "Chicken Meatbox");
  const base = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
  const order = await addOrderItem(db, {
    orderId: draft.id,
    menuItemId: item.id,
    quantity: 1,
    modifierIds: [base],
  });
  return order;
}

describe("order engine", () => {
  it("adds an item with required base and prices it server-side", async () => {
    const order = await draftWithChickenMeatbox();
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.unitPriceCents).toBe(1995);
    expect(order.subtotalCents).toBe(1995);
    expect(order.totalCents).toBe(1995);
  });

  it("rejects a missing required modifier group with a speakable message", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id });
    const item = await findItemByName(db, "Chicken Meatbox");
    await expect(
      addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1, modifierIds: [] }),
    ).rejects.toThrow(/needs a Base selection/);
  });

  it("rejects modifiers that belong to a different item", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id });
    const kebab = await findItemByName(db, "Chicken Kebab");
    const foreignMod = await modifierId(db, "Chicken Meatbox", "Chips & Salad");
    await expect(
      addOrderItem(db, {
        orderId: draft.id,
        menuItemId: kebab.id,
        quantity: 1,
        modifierIds: [foreignMod],
      }),
    ).rejects.toThrow(OrderValidationError);
  });

  it("rejects sold-out items (scenario 3)", async () => {
    const item = await findItemByName(db, "Chicken Kebab");
    await db.query(`UPDATE menu_items SET is_sold_out = true WHERE id = $1`, [item.id]);
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id });
    await expect(
      addOrderItem(db, { orderId: draft.id, menuItemId: item.id, quantity: 1 }),
    ).rejects.toThrow(/not available/);
  });

  it("adds priced extras into the line total", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id });
    const item = await findItemByName(db, "Chicken Meatbox");
    const base = await modifierId(db, "Chicken Meatbox", "Rice & Salad");
    const extraMeat = await modifierId(db, "Chicken Meatbox", "Extra meat");
    const order = await addOrderItem(db, {
      orderId: draft.id,
      menuItemId: item.id,
      quantity: 2,
      modifierIds: [base, extraMeat],
    });
    expect(order.items[0]!.lineTotalCents).toBe(2 * (1995 + 500));
    expect(order.totalCents).toBe(4990);
  });

  it("updates quantity and removals (scenario 2)", async () => {
    const order = await draftWithChickenMeatbox();
    const updated = await updateOrderItem(db, {
      orderId: order.id,
      orderItemId: order.items[0]!.id,
      quantity: 3,
      removals: ["onion"],
    });
    expect(updated.items[0]!.quantity).toBe(3);
    expect(updated.items[0]!.removals).toEqual(["onion"]);
    expect(updated.totalCents).toBe(3 * 1995);
  });

  it("removes lines and recalculates", async () => {
    const order = await draftWithChickenMeatbox();
    const after = await removeOrderItem(db, order.id, order.items[0]!.id);
    expect(after.items).toHaveLength(0);
    expect(after.totalCents).toBe(0);
  });

  it("confirms with an order number and requires a name", async () => {
    const order = await draftWithChickenMeatbox();
    await setOrderDetails(db, { orderId: order.id, customerName: "" });
    await expect(
      confirmOrder(db, { orderId: order.id, orderNumberPrefix: "MB" }),
    ).rejects.toThrow(/name/i);
    await setOrderDetails(db, { orderId: order.id, customerName: "Daniel" });
    const { order: confirmed, alreadyConfirmed } = await confirmOrder(db, {
      orderId: order.id,
      orderNumberPrefix: "MB",
    });
    expect(alreadyConfirmed).toBe(false);
    expect(confirmed.status).toBe("new");
    expect(confirmed.publicOrderNumber).toMatch(/^MB\d+$/);
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it("is idempotent on double confirmation (scenario 10)", async () => {
    const order = await draftWithChickenMeatbox();
    const first = await confirmOrder(db, { orderId: order.id, orderNumberPrefix: "MB" });
    const second = await confirmOrder(db, { orderId: order.id, orderNumberPrefix: "MB" });
    expect(second.alreadyConfirmed).toBe(true);
    expect(second.order.publicOrderNumber).toBe(first.order.publicOrderNumber);
    const count = await db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE status = 'new'`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("blocks cart changes after confirmation", async () => {
    const order = await draftWithChickenMeatbox();
    await confirmOrder(db, { orderId: order.id, orderNumberPrefix: "MB" });
    const item = await findItemByName(db, "Water");
    await expect(
      addOrderItem(db, { orderId: order.id, menuItemId: item.id, quantity: 1 }),
    ).rejects.toThrow(/confirmed/);
  });

  it("blocks confirming an empty order", async () => {
    const draft = await createDraft(db, { restaurantId: ctx.restaurant.id, customerName: "T" });
    await expect(
      confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" }),
    ).rejects.toThrow(/no items/);
  });

  it("enforces the kitchen status flow", async () => {
    const order = await draftWithChickenMeatbox();
    await confirmOrder(db, { orderId: order.id, orderNumberPrefix: "MB" });
    await updateOrderStatus(db, order.id, "accepted", "test@meatbox");
    await updateOrderStatus(db, order.id, "preparing", "test@meatbox");
    await updateOrderStatus(db, order.id, "ready", "test@meatbox");
    await updateOrderStatus(db, order.id, "completed", "test@meatbox");
    await expect(updateOrderStatus(db, order.id, "preparing", "t")).rejects.toThrow(
      /Can't move/,
    );
  });
});

describe("menu search", () => {
  it('finds the Meatbox from "one meat box" (scenario 11 fuzzy matching)', async () => {
    const results = await searchMenu(db, ctx.restaurant.id, "one meat box");
    expect(results.length).toBeGreaterThan(1); // several meatboxes -> AI must clarify
    expect(results[0]!.name).toContain("Meatbox");
  });

  it("finds items by alias", async () => {
    const results = await searchMenu(db, ctx.restaurant.id, "chic meatbox");
    expect(results[0]!.name).toBe("Chicken Meatbox");
  });

  it("finds nothing for gibberish", async () => {
    const results = await searchMenu(db, ctx.restaurant.id, "zzzqqqxxx");
    expect(results).toHaveLength(0);
  });
});
