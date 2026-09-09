import type { Queryable } from "../db/client";
import { camelRow, camelRows, type DailySpecial } from "../types";

export async function getActiveSpecials(
  db: Queryable,
  restaurantId: string,
  now: Date = new Date(),
): Promise<DailySpecial[]> {
  const res = await db.query(
    `
    SELECT * FROM daily_specials
    WHERE restaurant_id = $1
      AND active
      AND starts_at <= $2
      AND ends_at > $2
      AND (quantity_limit IS NULL OR quantity_used < quantity_limit)
    ORDER BY starts_at
    `,
    [restaurantId, now],
  );
  return camelRows<DailySpecial>(res.rows);
}

export async function getSpecial(db: Queryable, id: string): Promise<DailySpecial | null> {
  const res = await db.query(`SELECT * FROM daily_specials WHERE id = $1`, [id]);
  return res.rows[0] ? camelRow<DailySpecial>(res.rows[0]) : null;
}

export function isSpecialOrderable(special: DailySpecial, now: Date = new Date()): boolean {
  if (!special.active) return false;
  if (special.startsAt > now || special.endsAt <= now) return false;
  if (special.quantityLimit !== null && special.quantityUsed >= special.quantityLimit) {
    return false;
  }
  return true;
}
