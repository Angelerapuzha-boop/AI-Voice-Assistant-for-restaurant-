import type pg from "pg";
import { createPool } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { env } from "../src/env";
import { seed } from "../src/seed/seed";
import { getDefaultRestaurant, getHours, getSettings } from "../src/domain/settings";
import type { Restaurant, RestaurantHoursRow, RestaurantSettings } from "../src/types";
import type { Llm, LlmStreamEvent } from "../src/agent/llm";

export interface TestContext {
  db: pg.Pool;
  restaurant: Restaurant;
  settings: RestaurantSettings;
  hours: RestaurantHoursRow[];
}

export async function setupTestDb(): Promise<TestContext> {
  const db = createPool(env.TEST_DATABASE_URL);
  await runMigrations(db);
  await seed(db);
  const restaurant = await getDefaultRestaurant(db);
  const settings = await getSettings(db, restaurant.id);
  const hours = await getHours(db, restaurant.id);
  return { db, restaurant, settings, hours };
}

/** Wipe transactional data (orders/calls/notifications), keep the menu. */
export async function resetTransactionalData(db: pg.Pool): Promise<void> {
  await db.query(
    `TRUNCATE order_item_modifiers, order_items, notification_attempts, call_events, orders, calls CASCADE`,
  );
  await db.query(`UPDATE daily_specials SET quantity_used = 0`);
}

export async function findItemByName(db: pg.Pool, name: string): Promise<{ id: string }> {
  const res = await db.query(`SELECT id FROM menu_items WHERE name = $1`, [name]);
  if (!res.rows[0]) throw new Error(`seed item not found: ${name}`);
  return res.rows[0] as { id: string };
}

export async function modifierId(db: pg.Pool, itemName: string, modName: string): Promise<string> {
  const res = await db.query(
    `SELECT m.id FROM menu_item_modifiers m
     JOIN menu_item_modifier_groups g ON g.id = m.group_id
     JOIN menu_items i ON i.id = g.menu_item_id
     WHERE i.name = $1 AND m.name = $2`,
    [itemName, modName],
  );
  if (!res.rows[0]) throw new Error(`modifier not found: ${itemName} / ${modName}`);
  return (res.rows[0] as { id: string }).id;
}

/** Scripted LLM: each stream() call plays the next event list. */
export class FakeLlm implements Llm {
  readonly seenParams: unknown[] = [];
  constructor(private readonly scripts: LlmStreamEvent[][]) {}

  stream(params: unknown): AsyncIterable<LlmStreamEvent> {
    this.seenParams.push(params);
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeLlm: no more scripted turns");
    return (async function* () {
      for (const event of script) yield event;
    })();
  }
}

export function textTurn(text: string): LlmStreamEvent[] {
  return [
    { type: "text", text },
    { type: "stop", reason: "end_turn" },
  ];
}

export function toolTurn(
  name: string,
  input: Record<string, unknown>,
  id = `tu_${Math.random().toString(36).slice(2, 10)}`,
): LlmStreamEvent[] {
  return [
    { type: "tool_use", id, name, input },
    { type: "stop", reason: "tool_use" },
  ];
}
