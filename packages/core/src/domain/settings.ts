import type { Queryable } from "../db/client";
import {
  camelRow,
  camelRows,
  type Restaurant,
  type RestaurantHoursRow,
  type RestaurantSettings,
} from "../types";

export async function getDefaultRestaurant(db: Queryable): Promise<Restaurant> {
  const res = await db.query(`SELECT * FROM restaurants ORDER BY created_at LIMIT 1`);
  if (!res.rows[0]) throw new Error("No restaurant configured. Run the seed first.");
  return camelRow<Restaurant>(res.rows[0]);
}

export async function getSettings(db: Queryable, restaurantId: string): Promise<RestaurantSettings> {
  const res = await db.query(`SELECT * FROM restaurant_settings WHERE restaurant_id = $1`, [
    restaurantId,
  ]);
  if (!res.rows[0]) throw new Error(`No settings row for restaurant ${restaurantId}`);
  return camelRow<RestaurantSettings>(res.rows[0]);
}

export async function getHours(db: Queryable, restaurantId: string): Promise<RestaurantHoursRow[]> {
  const res = await db.query(
    `SELECT * FROM restaurant_hours WHERE restaurant_id = $1 ORDER BY day_of_week`,
    [restaurantId],
  );
  return camelRows<RestaurantHoursRow>(res.rows);
}
