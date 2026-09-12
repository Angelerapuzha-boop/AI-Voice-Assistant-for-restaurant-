import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addOrderItem,
  closeDb,
  confirmOrder,
  createDraft,
  env,
  getDb,
  getDefaultRestaurant,
  getSettings,
  runMigrations,
  seed,
  sweepGoogleReviewSms,
  upsertCustomerForOrder,
  type Restaurant,
  type RestaurantSettings,
} from "../src";

const PHONE = "+61455000111";
let restaurant: Restaurant;
let settings: RestaurantSettings;
let chickenId = "";
let baseModId = "";

async function completedOrder(phone = PHONE, hoursAgo = 2): Promise<string> {
  const db = getDb();
  const draft = await createDraft(db, {
    restaurantId: restaurant.id,
    customerPhone: phone,
    customerName: "Review Test",
    orderType: "takeaway",
    source: "phone",
  });
  await addOrderItem(db, {
    orderId: draft.id,
    menuItemId: chickenId,
    quantity: 1,
    modifierIds: [baseModId],
    removals: [],
  });
  const { order } = await confirmOrder(db, { orderId: draft.id, orderNumberPrefix: "MB" });
  await upsertCustomerForOrder(db, order); // production does this at confirm (flow.ts)
  await db.query(
    `UPDATE orders SET status = 'completed', updated_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
    [order.id, hoursAgo],
  );
  return order.id;
}

async function reviewSmsCount(): Promise<number> {
  const res = await getDb().query(
    `SELECT COUNT(*)::int AS n FROM notification_attempts WHERE kind = 'review_sms'`,
  );
  return (res.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  (env as { DATABASE_URL: string }).DATABASE_URL = env.TEST_DATABASE_URL;
  const db = getDb();
  await runMigrations(db);
  await seed(db);
  restaurant = await getDefaultRestaurant(db);
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
    `TRUNCATE inventory_movements, order_item_modifiers, order_items, notification_attempts, call_events, orders, customers CASCADE`,
  );
  await db.query(
    `UPDATE restaurant_settings SET customer_sms_enabled = true,
       google_review_url = 'https://g.page/r/meatboxwa/review' WHERE restaurant_id = $1`,
    [restaurant.id],
  );
  settings = await getSettings(db, restaurant.id);
});

afterAll(async () => {
  await closeDb();
});

describe("Google review SMS", () => {
  it("asks once, one hour after completion", async () => {
    await completedOrder();
    const sent = await sweepGoogleReviewSms(getDb(), { restaurant, settings });
    expect(sent).toBe(1);
    const row = await getDb().query(`SELECT to_number, body FROM notification_attempts WHERE kind = 'review_sms'`);
    expect(row.rows[0]).toMatchObject({ to_number: PHONE });
    expect((row.rows[0] as { body: string }).body).toContain("g.page/r/meatboxwa");
    // Sweep again: nothing new.
    expect(await sweepGoogleReviewSms(getDb(), { restaurant, settings })).toBe(0);
    expect(await reviewSmsCount()).toBe(1);
  });

  it("NEVER asks the same customer twice, even across later orders", async () => {
    await completedOrder();
    expect(await sweepGoogleReviewSms(getDb(), { restaurant, settings })).toBe(1);
    await completedOrder(PHONE, 3); // a second completed order, same phone
    expect(await sweepGoogleReviewSms(getDb(), { restaurant, settings })).toBe(0);
    expect(await reviewSmsCount()).toBe(1);
  });

  it("waits the full hour and respects the disabled state", async () => {
    await completedOrder(PHONE, 0); // just completed
    expect(await sweepGoogleReviewSms(getDb(), { restaurant, settings })).toBe(0);
    // Disabled when no URL configured.
    await completedOrder("+61455000222", 2);
    expect(
      await sweepGoogleReviewSms(getDb(), {
        restaurant,
        settings: { ...settings, googleReviewUrl: "" },
      }),
    ).toBe(0);
  });
});
