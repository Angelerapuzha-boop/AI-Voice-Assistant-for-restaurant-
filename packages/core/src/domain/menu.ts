import type { Queryable } from "../db/client";
import {
  camelRow,
  camelRows,
  type MenuCategory,
  type MenuItem,
  type Modifier,
  type ModifierGroup,
  type ModifierGroupWithModifiers,
} from "../types";

/** Normalise caller speech for matching: "Meat Box" -> "meatbox". */
export function normaliseQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/meat\s+box/g, "meatbox")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function listCategories(db: Queryable, restaurantId: string): Promise<MenuCategory[]> {
  const res = await db.query(
    `SELECT * FROM menu_categories WHERE restaurant_id = $1 AND active ORDER BY sort_order, name`,
    [restaurantId],
  );
  return camelRows<MenuCategory>(res.rows);
}

export async function listItems(
  db: Queryable,
  restaurantId: string,
  opts: { categoryId?: string; includeInactive?: boolean } = {},
): Promise<MenuItem[]> {
  const clauses = ["restaurant_id = $1"];
  const params: unknown[] = [restaurantId];
  if (!opts.includeInactive) clauses.push("active");
  if (opts.categoryId) {
    params.push(opts.categoryId);
    clauses.push(`category_id = $${params.length}`);
  }
  const res = await db.query(
    `SELECT * FROM menu_items WHERE ${clauses.join(" AND ")} ORDER BY sort_order, name`,
    params,
  );
  return camelRows<MenuItem>(res.rows);
}

export async function getItem(db: Queryable, menuItemId: string): Promise<MenuItem | null> {
  const res = await db.query(`SELECT * FROM menu_items WHERE id = $1`, [menuItemId]);
  return res.rows[0] ? camelRow<MenuItem>(res.rows[0]) : null;
}

export async function getModifierGroups(
  db: Queryable,
  menuItemId: string,
): Promise<ModifierGroupWithModifiers[]> {
  const groupsRes = await db.query(
    `SELECT * FROM menu_item_modifier_groups WHERE menu_item_id = $1 ORDER BY sort_order, name`,
    [menuItemId],
  );
  const groups = camelRows<ModifierGroup>(groupsRes.rows);
  if (groups.length === 0) return [];
  const modsRes = await db.query(
    `SELECT * FROM menu_item_modifiers WHERE group_id = ANY($1) ORDER BY sort_order, name`,
    [groups.map((g) => g.id)],
  );
  const mods = camelRows<Modifier>(modsRes.rows);
  return groups.map((g) => ({ ...g, modifiers: mods.filter((m) => m.groupId === g.id) }));
}

export async function getModifiersByIds(db: Queryable, ids: string[]): Promise<Modifier[]> {
  if (ids.length === 0) return [];
  const res = await db.query(`SELECT * FROM menu_item_modifiers WHERE id = ANY($1)`, [ids]);
  return camelRows<Modifier>(res.rows);
}

export interface MenuSearchResult extends MenuItem {
  categoryName: string;
  score: number;
}

/**
 * Fuzzy search over item names, aliases and descriptions.
 * Uses pg_trgm similarity + ILIKE so telephone speech like "one meat box"
 * still finds "Chicken Meatbox". Callers must clarify when several items match.
 */
export async function searchMenu(
  db: Queryable,
  restaurantId: string,
  rawQuery: string,
  limit = 8,
): Promise<MenuSearchResult[]> {
  const q = normaliseQuery(rawQuery);
  if (!q) return [];
  const res = await db.query(
    `
    SELECT mi.*, mc.name AS category_name,
      GREATEST(
        similarity(lower(mi.name), $2),
        (SELECT COALESCE(MAX(similarity(lower(a), $2)), 0) FROM unnest(mi.aliases) a),
        CASE WHEN lower(mi.name) ILIKE '%' || $2 || '%' THEN 0.6 ELSE 0 END,
        CASE WHEN EXISTS (
          SELECT 1 FROM unnest(mi.aliases) a WHERE lower(a) ILIKE '%' || $2 || '%'
        ) THEN 0.6 ELSE 0 END,
        CASE WHEN lower(mi.description) ILIKE '%' || $2 || '%' THEN 0.3 ELSE 0 END
      ) AS score
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    WHERE mi.restaurant_id = $1 AND mi.active
    ORDER BY score DESC, mi.sort_order
    LIMIT $3
    `,
    [restaurantId, q, limit],
  );
  return camelRows<MenuSearchResult>(res.rows)
    .map((r) => ({ ...r, score: Number(r.score) }))
    .filter((r) => r.score >= 0.25);
}
