import crypto from "node:crypto";
import type pg from "pg";
import type { Queryable } from "../db/client";
import { env } from "../env";
import { camelRow, type OrderWithItems } from "../types";
import { auditLog } from "./audit";

/**
 * Square platform integration.
 *
 * - One-click OAuth connect (Admin > Integrations) once SQUARE_APP_ID/SECRET
 *   are configured.
 * - Catalog import: pull categories/items/modifiers from Square into our menu
 *   (idempotent via square_id columns; owner-editable afterwards).
 * - Order push: confirmed orders are queued (outbox kind 'square_order') and
 *   created in Square as orders, so Square Dashboard/POS reporting and
 *   inventory see every phone/POS sale.
 */

export interface SquareConnection {
  id: string;
  restaurantId: string;
  merchantId: string;
  locationId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  environment: "sandbox" | "production";
  pushOrders: boolean;
  connectedAt: Date;
}

function apiBase(environment: string): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export function squareConfigured(): boolean {
  return Boolean(env.SQUARE_APP_ID && env.SQUARE_APP_SECRET);
}

export async function getSquareConnection(
  db: Queryable,
  restaurantId: string,
): Promise<SquareConnection | null> {
  const res = await db.query(`SELECT * FROM square_connections WHERE restaurant_id = $1`, [
    restaurantId,
  ]);
  return res.rows[0] ? camelRow<SquareConnection>(res.rows[0]) : null;
}

// ------------------------------------------------------------------ OAuth

const OAUTH_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "INVENTORY_READ",
  "PAYMENTS_READ",
].join(" ");

/** Signed state so the callback can't be forged. */
export function oauthState(): string {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const sig = crypto
    .createHmac("sha256", env.SESSION_SECRET || "dev")
    .update(nonce)
    .digest("base64url");
  return `${nonce}.${sig}`;
}

export function verifyOauthState(state: string): boolean {
  const [nonce, sig] = state.split(".");
  if (!nonce || !sig) return false;
  const expected = crypto
    .createHmac("sha256", env.SESSION_SECRET || "dev")
    .update(nonce)
    .digest("base64url");
  return sig === expected;
}

export function squareAuthorizeUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env.SQUARE_APP_ID,
    scope: OAUTH_SCOPES,
    session: "false",
    state: oauthState(),
    redirect_uri: redirectUri,
  });
  return `${apiBase(env.SQUARE_ENV)}/oauth2/authorize?${params}`;
}

async function squareFetch(
  environment: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase(environment)}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": "2026-07-16",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errors = JSON.stringify(json.errors ?? json).slice(0, 400);
    throw new Error(`Square ${res.status} on ${path}: ${errors}`);
  }
  return json;
}

export async function exchangeSquareCode(
  db: pg.Pool,
  restaurantId: string,
  code: string,
  redirectUri: string,
): Promise<SquareConnection> {
  const res = await fetch(`${apiBase(env.SQUARE_ENV)}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SQUARE_APP_ID,
      client_secret: env.SQUARE_APP_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: string;
    merchant_id?: string;
    errors?: unknown;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Square token exchange failed: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }

  // Discover the main location for order pushes.
  let locationId = "";
  try {
    const locations = (await squareFetch(env.SQUARE_ENV, json.access_token, "/v2/locations")) as {
      locations?: { id: string; status?: string }[];
    };
    locationId = locations.locations?.find((l) => l.status === "ACTIVE")?.id ?? locations.locations?.[0]?.id ?? "";
  } catch {
    // location discovery is best-effort; connection still saved
  }

  const row = await db.query(
    `INSERT INTO square_connections
       (restaurant_id, merchant_id, location_id, access_token, refresh_token, expires_at, environment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (restaurant_id) DO UPDATE SET
       merchant_id = EXCLUDED.merchant_id,
       location_id = EXCLUDED.location_id,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       environment = EXCLUDED.environment,
       connected_at = now()
     RETURNING *`,
    [
      restaurantId,
      json.merchant_id ?? "",
      locationId,
      json.access_token,
      json.refresh_token ?? "",
      json.expires_at ? new Date(json.expires_at) : null,
      env.SQUARE_ENV,
    ],
  );
  await auditLog(db, {
    restaurantId,
    actor: "system",
    action: "square.connected",
    entityType: "square_connection",
    changes: { merchantId: json.merchant_id, locationId },
  });
  return camelRow<SquareConnection>(row.rows[0] as Record<string, unknown>);
}

/** Refresh the access token when it's within 7 days of expiry. */
async function freshConnection(db: Queryable, conn: SquareConnection): Promise<SquareConnection> {
  if (!conn.expiresAt || conn.expiresAt.getTime() - Date.now() > 7 * 24 * 3600 * 1000) {
    return conn;
  }
  const res = await fetch(`${apiBase(conn.environment)}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SQUARE_APP_ID,
      client_secret: env.SQUARE_APP_SECRET,
      refresh_token: conn.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: string };
  if (!res.ok || !json.access_token) return conn; // keep trying with old token
  await db.query(
    `UPDATE square_connections SET access_token = $2, refresh_token = COALESCE(NULLIF($3, ''), refresh_token),
       expires_at = $4 WHERE id = $1`,
    [conn.id, json.access_token, json.refresh_token ?? "", json.expires_at ? new Date(json.expires_at) : null],
  );
  return {
    ...conn,
    accessToken: json.access_token,
    expiresAt: json.expires_at ? new Date(json.expires_at) : conn.expiresAt,
  };
}

export async function disconnectSquare(db: Queryable, restaurantId: string): Promise<void> {
  await db.query(`DELETE FROM square_connections WHERE restaurant_id = $1`, [restaurantId]);
  await auditLog(db, {
    restaurantId,
    actor: "system",
    action: "square.disconnected",
    entityType: "square_connection",
  });
}

export async function setSquarePushOrders(
  db: Queryable,
  restaurantId: string,
  enabled: boolean,
): Promise<void> {
  await db.query(`UPDATE square_connections SET push_orders = $2 WHERE restaurant_id = $1`, [
    restaurantId,
    enabled,
  ]);
}

// ------------------------------------------------------------------ catalog import

interface CatalogObject {
  type: string;
  id: string;
  category_data?: { name?: string };
  item_data?: {
    name?: string;
    description?: string;
    categories?: { id: string }[];
    category_id?: string;
    variations?: CatalogObject[];
    modifier_list_info?: { modifier_list_id: string; enabled?: boolean }[];
  };
  item_variation_data?: { name?: string; price_money?: { amount?: number } };
  modifier_list_data?: {
    name?: string;
    selection_type?: string;
    modifiers?: CatalogObject[];
  };
  modifier_data?: { name?: string; price_money?: { amount?: number } };
}

export interface ImportResult {
  categories: number;
  items: number;
  modifierGroups: number;
  skipped: string[];
}

/**
 * Import the Square catalog into our menu. Existing rows matched by
 * square_id are updated (name/price); everything stays editable in Admin.
 */
export async function importSquareCatalog(
  db: pg.Pool,
  restaurantId: string,
): Promise<ImportResult> {
  const base = await getSquareConnection(db, restaurantId);
  if (!base) throw new Error("Square is not connected.");
  const conn = await freshConnection(db, base);

  const objects: CatalogObject[] = [];
  let cursor = "";
  do {
    const page = (await squareFetch(
      conn.environment,
      conn.accessToken,
      `/v2/catalog/list?types=CATEGORY,ITEM,MODIFIER_LIST${cursor ? `&cursor=${cursor}` : ""}`,
    )) as { objects?: CatalogObject[]; cursor?: string };
    objects.push(...(page.objects ?? []));
    cursor = page.cursor ?? "";
  } while (cursor);

  const result: ImportResult = { categories: 0, items: 0, modifierGroups: 0, skipped: [] };
  const categoryIdMap = new Map<string, string>(); // square id -> our id
  const modifierLists = new Map<string, CatalogObject>();
  for (const obj of objects) {
    if (obj.type === "MODIFIER_LIST") modifierLists.set(obj.id, obj);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    for (const obj of objects.filter((o) => o.type === "CATEGORY")) {
      const name = obj.category_data?.name?.trim();
      if (!name) continue;
      const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const row = await client.query(
        `INSERT INTO menu_categories (restaurant_id, name, slug, square_id, sort_order)
         VALUES ($1, $2, $3, $4,
           (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM menu_categories WHERE restaurant_id = $1))
         ON CONFLICT (restaurant_id, slug) DO UPDATE SET name = EXCLUDED.name, square_id = EXCLUDED.square_id
         RETURNING id`,
        [restaurantId, name, slugBase || obj.id.toLowerCase(), obj.id],
      );
      categoryIdMap.set(obj.id, (row.rows[0] as { id: string }).id);
      result.categories++;
    }

    // Fallback category for items with no category mapping.
    const fallback = await client.query(
      `INSERT INTO menu_categories (restaurant_id, name, slug, sort_order)
       VALUES ($1, 'Imported from Square', 'square-imported', 999)
       ON CONFLICT (restaurant_id, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [restaurantId],
    );
    const fallbackCategoryId = (fallback.rows[0] as { id: string }).id;

    for (const obj of objects.filter((o) => o.type === "ITEM")) {
      const data = obj.item_data;
      const name = data?.name?.trim();
      if (!name) continue;
      const variations = (data?.variations ?? []).filter((v) => v.item_variation_data);
      const prices = variations
        .map((v) => v.item_variation_data?.price_money?.amount)
        .filter((p): p is number => typeof p === "number");
      if (prices.length === 0) {
        result.skipped.push(`${name} (no fixed price)`);
        continue;
      }
      const basePrice = Math.min(...prices);
      const squareCatId = data?.categories?.[0]?.id ?? data?.category_id ?? "";
      const categoryId = categoryIdMap.get(squareCatId) ?? fallbackCategoryId;

      const itemRow = await client.query(
        `INSERT INTO menu_items (restaurant_id, category_id, name, description, price_cents, square_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [restaurantId, categoryId, name, data?.description ?? "", basePrice, obj.id],
      );
      let itemId: string;
      if (itemRow.rows[0]) {
        itemId = (itemRow.rows[0] as { id: string }).id;
      } else {
        const existing = await client.query(
          `SELECT id FROM menu_items WHERE restaurant_id = $1 AND square_id = $2`,
          [restaurantId, obj.id],
        );
        if (!existing.rows[0]) {
          result.skipped.push(name);
          continue;
        }
        itemId = (existing.rows[0] as { id: string }).id;
        await client.query(
          `UPDATE menu_items SET name = $2, price_cents = $3, updated_at = now() WHERE id = $1`,
          [itemId, name, basePrice],
        );
      }
      result.items++;

      // Multiple variations (sizes) become a required choice group.
      if (variations.length > 1) {
        await upsertGroup(client, itemId, `${obj.id}-variations`, "Size / Choice", true, 1,
          variations.map((v) => ({
            squareId: v.id,
            name: v.item_variation_data?.name ?? "Option",
            priceCents: Math.max(0, (v.item_variation_data?.price_money?.amount ?? basePrice) - basePrice),
          })),
        );
        result.modifierGroups++;
      }

      for (const info of data?.modifier_list_info ?? []) {
        if (info.enabled === false) continue;
        const list = modifierLists.get(info.modifier_list_id);
        const listData = list?.modifier_list_data;
        if (!list || !listData?.name) continue;
        const single = listData.selection_type === "SINGLE";
        await upsertGroup(client, itemId, list.id, listData.name, false, single ? 1 : 10,
          (listData.modifiers ?? []).map((m) => ({
            squareId: m.id,
            name: m.modifier_data?.name ?? "Option",
            priceCents: m.modifier_data?.price_money?.amount ?? 0,
          })),
        );
        result.modifierGroups++;
      }
    }

    await auditLog(client, {
      restaurantId,
      actor: "system",
      action: "square.catalog_imported",
      entityType: "menu",
      changes: { categories: result.categories, items: result.items, groups: result.modifierGroups },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return result;
}

async function upsertGroup(
  client: pg.PoolClient,
  itemId: string,
  squareId: string,
  name: string,
  required: boolean,
  maxSelect: number,
  modifiers: { squareId: string; name: string; priceCents: number }[],
): Promise<void> {
  const existing = await client.query(
    `SELECT id FROM menu_item_modifier_groups WHERE menu_item_id = $1 AND square_id = $2`,
    [itemId, squareId],
  );
  let groupId: string;
  if (existing.rows[0]) {
    groupId = (existing.rows[0] as { id: string }).id;
    await client.query(`UPDATE menu_item_modifier_groups SET name = $2 WHERE id = $1`, [groupId, name]);
  } else {
    const row = await client.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, name, required, max_select, square_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [itemId, name, required, maxSelect, squareId],
    );
    groupId = (row.rows[0] as { id: string }).id;
  }
  for (const mod of modifiers) {
    const existingMod = await client.query(
      `SELECT id FROM menu_item_modifiers WHERE group_id = $1 AND square_id = $2`,
      [groupId, mod.squareId],
    );
    if (existingMod.rows[0]) {
      await client.query(`UPDATE menu_item_modifiers SET name = $2, price_cents = $3 WHERE id = $1`, [
        (existingMod.rows[0] as { id: string }).id,
        mod.name,
        mod.priceCents,
      ]);
    } else {
      await client.query(
        `INSERT INTO menu_item_modifiers (group_id, name, price_cents, square_id) VALUES ($1, $2, $3, $4)`,
        [groupId, mod.name, mod.priceCents, mod.squareId],
      );
    }
  }
}

// ------------------------------------------------------------------ order push

/** Queue a confirmed order for creation in Square (rides the outbox). */
export async function enqueueSquareOrderPush(
  db: Queryable,
  restaurantId: string,
  order: OrderWithItems,
): Promise<void> {
  const conn = await getSquareConnection(db, restaurantId);
  if (!conn || !conn.pushOrders || !conn.locationId) return;
  const body = JSON.stringify({
    restaurantId,
    orderId: order.id,
    referenceId: order.publicOrderNumber,
    lineItems: order.items.map((i) => ({
      name: i.nameSnapshot,
      quantity: String(i.quantity),
      base_price_money: {
        amount: i.unitPriceCents + i.modifiers.reduce((sum, m) => sum + m.priceCents, 0),
        currency: "AUD",
      },
      note: [
        ...i.modifiers.map((m) => m.nameSnapshot),
        ...i.removals.map((r) => `No ${r}`),
        i.specialInstructions,
      ]
        .filter(Boolean)
        .join(", ")
        .slice(0, 500),
    })),
  });
  await db.query(
    `INSERT INTO notification_attempts (order_id, kind, to_number, body)
     VALUES ($1, 'square_order', $2, $3)`,
    [order.id, restaurantId, body],
  );
}

export interface SquareOrderSender {
  send(restaurantId: string, body: string): Promise<{ sid: string }>;
}

export function createSquareOrderSender(db: pg.Pool): SquareOrderSender {
  return {
    async send(restaurantId: string, body: string) {
      const base = await getSquareConnection(db, restaurantId);
      if (!base) throw new Error("Square disconnected — order push skipped");
      const conn = await freshConnection(db, base);
      const payload = JSON.parse(body) as {
        orderId: string;
        referenceId: string | null;
        lineItems: unknown[];
      };
      const res = (await squareFetch(conn.environment, conn.accessToken, "/v2/orders", {
        method: "POST",
        body: {
          idempotency_key: `meatbox-${payload.orderId}`,
          order: {
            location_id: conn.locationId,
            reference_id: payload.referenceId ?? undefined,
            source: { name: "Meatbox AI phone/POS" },
            line_items: payload.lineItems,
            state: "OPEN",
          },
        },
      })) as { order?: { id?: string } };
      return { sid: res.order?.id ?? "square-ok" };
    },
  };
}
