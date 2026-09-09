/**
 * Dev utility: place one confirmed demo order in the DEV database so the
 * kitchen dashboard / SMS outbox can be exercised without a phone call.
 *
 *   pnpm --filter @meatbox/core run demo-order
 *
 * Clean up afterwards from the kitchen view (Cancel) — demo orders are
 * clearly named "DEMO Walk-through".
 */
import { closeDb, getDb } from "../db/client";
import { addOrderItem, createDraft } from "../domain/orders";
import { confirmOrderWithNotifications } from "../domain/flow";
import { getDefaultRestaurant, getSettings } from "../domain/settings";

const db = getDb();
const restaurant = await getDefaultRestaurant(db);
const settings = await getSettings(db, restaurant.id);

const itemRes = await db.query(
  `SELECT id FROM menu_items WHERE name = 'Chicken Meatbox' AND restaurant_id = $1`,
  [restaurant.id],
);
const itemId = (itemRes.rows[0] as { id: string }).id;
const modRes = await db.query(
  `SELECT m.id, m.name FROM menu_item_modifiers m
   JOIN menu_item_modifier_groups g ON g.id = m.group_id
   WHERE g.menu_item_id = $1 AND m.name IN ('Chips & Salad', 'Garlic sauce', 'Extra meat')`,
  [itemId],
);
const modIds = modRes.rows.map((r) => (r as { id: string }).id);

const draft = await createDraft(db, {
  restaurantId: restaurant.id,
  customerName: "DEMO Walk-through",
  customerPhone: "+61400000000",
  orderType: "takeaway",
});
await addOrderItem(db, {
  orderId: draft.id,
  menuItemId: itemId,
  quantity: 2,
  modifierIds: modIds,
  removals: ["onion"],
  specialInstructions: "extra crispy chips",
});
const { order } = await confirmOrderWithNotifications(db, {
  orderId: draft.id,
  restaurant,
  settings,
  actor: "demo-script",
});
console.log(
  `Confirmed demo order ${order.publicOrderNumber} — total ${order.totalCents} cents. ` +
    `Check the kitchen dashboard; cancel it there when done.`,
);
await closeDb();
