import type pg from "pg";
import { hashPassword } from "../auth";
import { env } from "../env";
import { auditLog } from "../domain/audit";
import { SEED_CATEGORIES } from "./seed-data";

export const SEED_OWNER_EMAIL = "owner@meatbox.local";
export const SEED_OWNER_PASSWORD = "MeatboxAdmin!2026";

/**
 * Idempotent seed: creates Meatbox WA with its real trading details,
 * the seed menu, an owner login and one demo special. If the restaurant
 * already exists it only tops up missing settings/users and leaves the
 * (possibly owner-edited) menu alone.
 */
export async function seed(db: pg.Pool): Promise<{ restaurantId: string; created: boolean }> {
  const existing = await db.query(`SELECT id FROM restaurants WHERE name = 'Meatbox WA'`);
  if (existing.rows[0]) {
    return { restaurantId: (existing.rows[0] as { id: string }).id, created: false };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const restRes = await client.query(
      `INSERT INTO restaurants (name, phone_display, address, timezone)
       VALUES ('Meatbox WA', '(08) 9440 1455',
               '229 North Beach Drive, Tuart Hill WA 6060', 'Australia/Perth')
       RETURNING id`,
    );
    const restaurantId = (restRes.rows[0] as { id: string }).id;

    await client.query(
      `INSERT INTO restaurant_settings (restaurant_id, owner_sms_number)
       VALUES ($1, $2)`,
      [restaurantId, env.OWNER_NOTIFICATION_PHONE],
    );

    // Real trading hours from meatboxwa.com.au (2026-09-09): 5:00pm – 1:00am daily.
    for (let day = 0; day < 7; day++) {
      await client.query(
        `INSERT INTO restaurant_hours (restaurant_id, day_of_week, opens_at, closes_at)
         VALUES ($1, $2, '17:00', '01:00')`,
        [restaurantId, day],
      );
    }

    const passwordHash = await hashPassword(SEED_OWNER_PASSWORD);
    await client.query(
      `INSERT INTO users (restaurant_id, email, name, password_hash, role)
       VALUES ($1, $2, 'Meatbox Owner', $3, 'owner')`,
      [restaurantId, SEED_OWNER_EMAIL, passwordHash],
    );

    let categorySort = 0;
    for (const category of SEED_CATEGORIES) {
      const catRes = await client.query(
        `INSERT INTO menu_categories (restaurant_id, name, slug, description, sort_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [restaurantId, category.name, category.slug, category.description ?? "", categorySort++],
      );
      const categoryId = (catRes.rows[0] as { id: string }).id;
      let itemSort = 0;
      for (const item of category.items) {
        const itemRes = await client.query(
          `INSERT INTO menu_items
            (restaurant_id, category_id, name, description, price_cents,
             is_vegetarian, is_popular, aliases, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            restaurantId,
            categoryId,
            item.name,
            item.description,
            item.priceCents,
            item.vegetarian ?? false,
            item.popular ?? false,
            item.aliases ?? [],
            itemSort++,
          ],
        );
        const itemId = (itemRes.rows[0] as { id: string }).id;
        let groupSort = 0;
        for (const group of item.groups ?? []) {
          const groupRes = await client.query(
            `INSERT INTO menu_item_modifier_groups
              (menu_item_id, name, required, min_select, max_select, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [
              itemId,
              group.name,
              group.required ?? false,
              group.minSelect ?? 0,
              group.maxSelect ?? 1,
              groupSort++,
            ],
          );
          const groupId = (groupRes.rows[0] as { id: string }).id;
          let modSort = 0;
          for (const mod of group.modifiers) {
            await client.query(
              `INSERT INTO menu_item_modifiers (group_id, name, price_cents, sort_order)
               VALUES ($1, $2, $3, $4)`,
              [groupId, mod.name, mod.priceCents ?? 0, modSort++],
            );
          }
        }
      }
    }

    // One demo special covering the next 7 days so the AI has something to say.
    const now = new Date();
    const weekOut = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    await client.query(
      `INSERT INTO daily_specials (restaurant_id, name, description, price_cents, starts_at, ends_at)
       VALUES ($1, 'Half Chicken & Chips Deal',
               'Half charcoal chicken with chips and garlic dip — this week only. [seed demo — replace with a real special]',
               1995, $2, $3)`,
      [restaurantId, now, weekOut],
    );

    await auditLog(client, {
      restaurantId,
      actor: "system",
      action: "seed.imported",
      entityType: "restaurant",
      entityId: restaurantId,
      changes: {
        note: "Seed menu imported from meatboxwa.com.au 2026-09-09; [rep] prices are representative and need owner review",
      },
    });

    await client.query("COMMIT");
    return { restaurantId, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
