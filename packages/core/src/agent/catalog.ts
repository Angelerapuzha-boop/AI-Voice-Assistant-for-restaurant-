import type { Queryable } from "../db/client";
import { formatCents } from "../money";
import { getModifierGroups, listCategories, listItems } from "../domain/menu";
import type { ModifierGroupWithModifiers } from "../types";

/**
 * Compact per-call menu briefing for the system prompt, plus name->id
 * resolution so the model orders by EXACT NAME and never sees a UUID.
 * Built once at call setup (so it reflects current availability) and
 * cached with the rest of the prompt prefix. Latency win: the model can
 * call add_order_item in its FIRST round instead of spending rounds on
 * search_menu / get_available_modifiers.
 */

export async function buildMenuCatalog(db: Queryable, restaurantId: string): Promise<string> {
  const [categories, items] = await Promise.all([
    listCategories(db, restaurantId),
    listItems(db, restaurantId),
  ]);
  const lines: string[] = [];
  for (const category of categories) {
    const catItems = items.filter((i) => i.categoryId === category.id);
    if (catItems.length === 0) continue;
    lines.push(`${category.name.toUpperCase()}:`);
    for (const item of catItems) {
      const groups = await getModifierGroups(db, item.id);
      const bits: string[] = [`- ${item.name} ${formatCents(item.priceCents)}`];
      if (item.isVegetarian) bits.push("(V)");
      if (item.isSoldOut || !item.isAvailable) bits.push("[SOLD OUT]");
      for (const group of groups) {
        const required = group.required || group.minSelect > 0;
        const options = group.modifiers
          .filter((m) => m.isAvailable)
          .map((m) => (m.priceCents > 0 ? `${m.name} +${formatCents(m.priceCents)}` : m.name))
          .join(" | ");
        if (!options) continue;
        bits.push(
          `{${required ? "REQUIRED " : ""}${group.name}${group.maxSelect > 1 ? ` max${group.maxSelect}` : ""}: ${options}}`,
        );
      }
      lines.push(bits.join(" "));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- resolvers

export async function resolveMenuItemByName(
  db: Queryable,
  restaurantId: string,
  name: string,
): Promise<{ id: string } | { error: string }> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return { error: "menuItemName was empty." };
  const items = await listItems(db, restaurantId);
  const exact = items.filter((i) => i.name.toLowerCase() === wanted);
  if (exact.length === 1) return { id: exact[0]!.id };
  const aliased = items.filter((i) => i.aliases.some((a) => a.toLowerCase() === wanted));
  if (aliased.length === 1) return { id: aliased[0]!.id };
  const contains = items.filter((i) => i.name.toLowerCase().includes(wanted));
  if (contains.length === 1) return { id: contains[0]!.id };
  return {
    error:
      contains.length > 1
        ? `Ambiguous item "${name}": ${contains.map((i) => i.name).join(", ")}. Use the exact menu name.`
        : `No menu item named "${name}". Use the exact name from the MENU section or search_menu.`,
  };
}

export function resolveModifierNames(
  groups: ModifierGroupWithModifiers[],
  names: string[],
): { ids: string[] } | { error: string } {
  const ids: string[] = [];
  for (const raw of names) {
    const wanted = raw.trim().toLowerCase();
    if (!wanted) continue;
    const all = groups.flatMap((g) => g.modifiers.filter((m) => m.isAvailable));
    let matches = all.filter((m) => m.name.toLowerCase() === wanted);
    if (matches.length === 0) {
      matches = all.filter((m) => m.name.toLowerCase().includes(wanted));
    }
    if (matches.length !== 1) {
      const options = groups
        .map((g) => `${g.name}: ${g.modifiers.filter((m) => m.isAvailable).map((m) => m.name).join(", ")}`)
        .join("; ");
      return {
        error:
          matches.length === 0
            ? `No option "${raw}" for this item. Options — ${options}.`
            : `Option "${raw}" is ambiguous (${matches.map((m) => m.name).join(", ")}). Use the exact option name.`,
      };
    }
    if (!ids.includes(matches[0]!.id)) ids.push(matches[0]!.id);
  }
  return { ids };
}
