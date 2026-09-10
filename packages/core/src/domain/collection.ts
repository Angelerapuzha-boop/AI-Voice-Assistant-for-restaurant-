import crypto from "node:crypto";
import type { Queryable } from "../db/client";
import { env } from "../env";
import type { OrderWithItems } from "../types";
import { getOrderWithItems } from "./orders";

/**
 * Collection kiosk (spec 14). Retrieval is VERIFIED, never open: an order
 * number alone reveals nothing — the caller must also present the 4-digit
 * pickup code shown on their private tracking page. Lookups are rate-limited
 * per IP and per order number, and every failure returns the same generic
 * message so the kiosk never confirms whether an order or customer exists.
 */

const CODE_SECRET = () => env.SESSION_SECRET || "dev-collect-secret";

/** Deterministic 4-digit pickup code — derived, never stored. */
export function collectionCode(orderId: string): string {
  const digest = crypto.createHmac("sha256", CODE_SECRET()).update(`collect:${orderId}`).digest();
  return String(digest.readUInt32BE(0) % 10000).padStart(4, "0");
}

export const KIOSK_GENERIC_ERROR =
  "We couldn't match that order number and code. Check both on your tracking page, or see staff at the counter.";

const WINDOW_MINUTES = 10;
const MAX_FAILURES = 5;

export function normaliseOrderNumber(raw: string, prefix = "MB"): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";
  return /^\d+$/.test(cleaned) ? `${prefix}${cleaned}` : cleaned;
}

async function tooManyFailures(db: Queryable, ip: string, orderKey: string): Promise<boolean> {
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE ip = $1)::int AS by_ip,
       COUNT(*) FILTER (WHERE order_key = $2)::int AS by_order
     FROM kiosk_lookup_failures WHERE at > now() - ($3 || ' minutes')::interval`,
    [ip, orderKey, String(WINDOW_MINUTES)],
  );
  const row = res.rows[0] as { by_ip: number; by_order: number };
  return row.by_ip >= MAX_FAILURES || row.by_order >= MAX_FAILURES;
}

async function recordFailure(db: Queryable, ip: string, orderKey: string): Promise<void> {
  await db.query(`INSERT INTO kiosk_lookup_failures (ip, order_key) VALUES ($1, $2)`, [ip, orderKey]);
  // Opportunistic cleanup so the table never grows unbounded.
  await db.query(`DELETE FROM kiosk_lookup_failures WHERE at < now() - interval '1 day'`);
}

export class KioskLookupError extends Error {
  constructor() {
    super(KIOSK_GENERIC_ERROR);
    this.name = "KioskLookupError";
  }
}

/**
 * Verified kiosk retrieval. Success returns the order scoped to this one
 * pickup; ANY failure (unknown number, wrong code, rate limit, cancelled
 * order) is the same generic error — no enumeration signal.
 */
export async function kioskLookup(
  db: Queryable,
  params: { restaurantId: string; orderNumber: string; code: string; ip: string },
): Promise<OrderWithItems> {
  const orderKey = normaliseOrderNumber(params.orderNumber);
  const code = params.code.trim();
  if (!orderKey || !/^\d{4}$/.test(code) || (await tooManyFailures(db, params.ip, orderKey))) {
    if (orderKey) await recordFailure(db, params.ip, orderKey);
    throw new KioskLookupError();
  }
  const res = await db.query(
    `SELECT id FROM orders
     WHERE restaurant_id = $1 AND public_order_number = $2
       AND status IN ('new', 'accepted', 'preparing', 'ready', 'completed')`,
    [params.restaurantId, orderKey],
  );
  const row = res.rows[0] as { id: string } | undefined;
  const expected = row ? collectionCode(row.id) : "0000";
  const supplied = Buffer.from(code.padEnd(4, "x"));
  const wanted = Buffer.from(expected);
  const codeOk =
    supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
  if (!row || !codeOk) {
    await recordFailure(db, params.ip, orderKey);
    throw new KioskLookupError();
  }
  return (await getOrderWithItems(db, row.id))!;
}

// ---------------------------------------------------- kiosk session tokens

/**
 * Short-lived signed token so the kiosk's pay/status calls stay scoped to
 * the one verified order without re-entering the code each step.
 */
export function kioskSessionToken(orderId: string, ttlSeconds = 300): string {
  const exp = Date.now() + ttlSeconds * 1000;
  const payload = `${orderId}.${exp}`;
  const sig = crypto.createHmac("sha256", CODE_SECRET()).update(`kiosk:${payload}`).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyKioskSessionToken(token: string): { orderId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [orderId, expStr, sig] = parts as [string, string, string];
  const expected = crypto
    .createHmac("sha256", CODE_SECRET())
    .update(`kiosk:${orderId}.${expStr}`)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(expStr) < Date.now()) return null;
  return { orderId };
}

// ------------------------------------------------------------- ready board

/** Public ready board: order numbers ONLY (spec 14 — no names, ever). */
export async function readyBoard(
  db: Queryable,
  restaurantId: string,
): Promise<{ ready: string[]; preparing: string[] }> {
  const res = await db.query(
    `SELECT public_order_number, status FROM orders
     WHERE restaurant_id = $1 AND status IN ('preparing', 'ready')
       AND public_order_number IS NOT NULL
     ORDER BY confirmed_at`,
    [restaurantId],
  );
  const rows = res.rows as { public_order_number: string; status: string }[];
  return {
    ready: rows.filter((r) => r.status === "ready").map((r) => r.public_order_number),
    preparing: rows.filter((r) => r.status === "preparing").map((r) => r.public_order_number),
  };
}
