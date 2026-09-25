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

/** All distinct modifier (sauce/salad/flavour) names for a restaurant — one
 *  cheap query, used to bias the STT toward option words ("toum", "halloumi"). */
export async function listModifierNames(db: Queryable, restaurantId: string): Promise<string[]> {
  const res = await db.query(
    `SELECT DISTINCT m.name FROM menu_item_modifiers m
       JOIN menu_item_modifier_groups g ON g.id = m.group_id
       JOIN menu_items i ON i.id = g.menu_item_id
      WHERE i.restaurant_id = $1`,
    [restaurantId],
  );
  return res.rows.map((r) => (r as { name: string }).name).filter(Boolean);
}

// Words that never need STT biasing — filler, portion/prep words, and common
// proteins/veg/sauces that any decent transcription already gets right. Keeping
// them out frees the 50 keyterm slots for the distinctive cuisine vocabulary
// ("gozleme", "meatbox", "manakish") that a poor line actually mangles.
const KEYTERM_STOP = new Set([
  // Pure filler / portion / format words only. The option/decision words a
  // caller must SAY — "chips", "rice", "garlic", "chilli", "onion" — are NOT
  // stopped: they're exactly where a poor line mishears ("chips" -> "chicken"),
  // so biasing toward them is the whole point.
  "with", "and", "the", "of", "in", "on", "for", "plus", "combo", "meal", "meals",
  "plate", "piece", "pieces", "small", "large", "regular", "half", "whole",
  "quarter", "mixed", "fresh", "hot", "cold", "salad", "salads",
  "drink", "drinks", "soft", "can", "bottle", "size", "each", "only", "new",
  "original", "classic", "fruit", "milk", "tea", "sauce", "dip", "roll", "wrap",
  "box", "skewer", "skewers", "meat", "your", "our", "extra",
  "family", "kids", "full", "grill", "platter", "vegetarian", "sweet",
  "burger", "pizza",
]);

/**
 * Distinctive menu vocabulary to bias Scribe toward (keyterm prompting: at most
 * 50 terms, 20 chars each, passed as repeated `?keyterms=` query params).
 * Distinctive SINGLE words first — the nouns a caller actually says ("gozleme",
 * "meatbox", "hummus", "toum") and that a poor line garbles — taking aliases
 * before item names so curated hard spellings ("felafel", "kofta") win a slot.
 * Short multiword phrases ("shish taouk") fill any slots left over. De-duped
 * case-insensitively, capped at `limit`.
 */
export function buildKeyterms(phrases: string[], limit = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.replace(/[^a-zA-Z'\- ]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 20 || out.length >= limit) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  // Pass 1: distinctive single words, in phrase order. Threshold 3 (not 4) so
  // short-but-critical answer words like "bbq" get biased — a poor line mishears
  // them badly and they're exactly what a caller says. Stopwords filter noise.
  for (const p of phrases) {
    for (const w of p.split(/[\s/]+/)) {
      if (w.length >= 3 && !KEYTERM_STOP.has(w.toLowerCase())) add(w);
    }
  }
  // Pass 2: short multiword phrases fill any remaining slots ("shish taouk").
  for (const p of phrases) {
    const c = p.trim();
    if (c.includes(" ") && c.length <= 20) add(c);
  }
  return out.slice(0, limit);
}

/** LLM-supplied ids reach uuid columns — a non-uuid must mean "not found", never a thrown 22P02. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getItem(db: Queryable, menuItemId: string): Promise<MenuItem | null> {
  if (!UUID_RE.test(menuItemId)) return null;
  const res = await db.query(`SELECT * FROM menu_items WHERE id = $1`, [menuItemId]);
  return res.rows[0] ? camelRow<MenuItem>(res.rows[0]) : null;
}

export async function getModifierGroups(
  db: Queryable,
  menuItemId: string,
): Promise<ModifierGroupWithModifiers[]> {
  if (!UUID_RE.test(menuItemId)) return [];
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
