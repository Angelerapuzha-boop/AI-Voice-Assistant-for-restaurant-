import type pg from "pg";
import { withTransaction, type Queryable } from "../db/client";
import {
  camelRow,
  camelRows,
  type Reservation,
  type ReservationSettings,
  type RestaurantHoursRow,
} from "../types";
import { localToday } from "./reservation-time";

// ---------------------------------------------------------------- helpers

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

function fmtHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Day-of-week (0=Sun) for an ISO date. */
function dowOfIso(dateIso: string): number {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
}

function diffDays(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  return Math.round((Date.UTC(ay!, am! - 1, ad!) - Date.UTC(by!, bm! - 1, bd!)) / 86_400_000);
}

/** Local wall-clock minutes-of-day right now in a timezone. */
function localNowMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** Is a wall-clock time within opening hours for that day (overnight-aware)? */
function withinHours(hours: RestaurantHoursRow[], dow: number, minutes: number): boolean {
  const day = hours.find((r) => r.dayOfWeek === dow);
  const prev = hours.find((r) => r.dayOfWeek === (dow + 6) % 7);
  const win = (row?: RestaurantHoursRow) => {
    if (!row || row.isClosed || !row.opensAt || !row.closesAt) return null;
    const opens = toMinutes(row.opensAt);
    const closes = toMinutes(row.closesAt);
    return { opens, closes, overnight: closes <= opens };
  };
  const today = win(day);
  if (today) {
    const closesAbs = today.overnight ? today.closes + 1440 : today.closes;
    if (minutes >= today.opens && minutes < closesAbs) return true;
  }
  // Previous day's overnight tail (e.g. a 00:30 booking under 5pm–1am hours).
  const y = win(prev);
  if (y?.overnight && minutes < y.closes) return true;
  return false;
}

// ---------------------------------------------------------------- settings

const DEFAULT_SETTINGS: Omit<ReservationSettings, "restaurantId"> = {
  reservationsEnabled: true,
  maxCoversPerSlot: 20,
  maxPartySize: 10,
  slotIntervalMinutes: 15,
  turnoverMinutes: 90,
  minAdvanceMinutes: 30,
  maxAdvanceDays: 120,
  refPrefix: "R",
};

export async function getReservationSettings(
  db: Queryable,
  restaurantId: string,
): Promise<ReservationSettings> {
  const res = await db.query(`SELECT * FROM reservation_settings WHERE restaurant_id = $1`, [restaurantId]);
  if (!res.rows[0]) return { restaurantId, ...DEFAULT_SETTINGS };
  return camelRow<ReservationSettings>(res.rows[0]);
}

// ---------------------------------------------------------------- availability

export type AvailabilityStatus =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "ALTERNATIVES_AVAILABLE"
  | "CLOSED"
  | "INVALID_DATE"
  | "PARTY_TOO_LARGE";

export interface AvailabilityResult {
  status: AvailabilityStatus;
  alternatives: string[]; // up to 3 nearby "HH:MM" times, nearest first
}

export interface AvailabilityInput {
  db: Queryable;
  restaurantId: string;
  hours: RestaurantHoursRow[];
  settings: ReservationSettings;
  timezone: string;
  now: Date;
  date: string; // ISO YYYY-MM-DD (already normalised)
  time: string; // HH:MM 24h (already normalised)
  partySize: number;
  /** When re-checking for a modify, ignore this reservation's own covers. */
  excludeReservationId?: string;
  /** Book into the party hall / function room: the big-group size cap and the
   * main-floor per-slot cover limit don't apply (the hall is its own space), but
   * opening hours / past-date / min-advance are still enforced (Kevin 2026-10-09). */
  allowPartyHall?: boolean;
}

/** Covers already booked that OVERLAP a candidate time (turnover window). */
function coversAt(
  existing: { minutes: number; partySize: number }[],
  candidateMin: number,
  turnover: number,
): number {
  return existing
    .filter((e) => Math.abs(e.minutes - candidateMin) < turnover)
    .reduce((sum, e) => sum + e.partySize, 0);
}

/**
 * Deterministic availability. The LLM never decides this — only this function
 * does, from the reservation table + configured rules (spec §3).
 */
export async function checkAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
  const { settings, hours, timezone, now, date, time, partySize } = input;
  const none: string[] = [];

  if (!settings.reservationsEnabled) return { status: "CLOSED", alternatives: none };
  if (!Number.isInteger(partySize) || partySize < 1) return { status: "INVALID_DATE", alternatives: none };
  // A party hall booking isn't bound by the per-table size cap (it's the separate
  // function room); its upper bound (the hall's capacity) is enforced by the caller.
  if (!input.allowPartyHall && partySize > settings.maxPartySize) return { status: "PARTY_TOO_LARGE", alternatives: none };

  const today = localToday(now, timezone);
  const todayIso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const dayDelta = diffDays(date, todayIso);
  if (dayDelta < 0) return { status: "INVALID_DATE", alternatives: none };
  if (dayDelta > settings.maxAdvanceDays) return { status: "INVALID_DATE", alternatives: none };

  const reqMin = toMinutes(time);
  const nowMin = localNowMinutes(now, timezone);
  // Too soon (today, before now + min advance).
  if (dayDelta === 0 && reqMin < nowMin + settings.minAdvanceMinutes) {
    return { status: "INVALID_DATE", alternatives: none };
  }

  const dow = dowOfIso(date);
  if (!withinHours(hours, dow, reqMin)) return { status: "CLOSED", alternatives: none };

  // Confirmed covers on that date.
  const res = await input.db.query(
    `SELECT reservation_time, party_size, special_requests FROM reservations
      WHERE restaurant_id = $1 AND reservation_date = $2 AND status = 'CONFIRMED'
        AND ($3::uuid IS NULL OR id <> $3)`,
    [input.restaurantId, date, input.excludeReservationId ?? null],
  );
  const existing = res.rows
    // Party-hall bookings occupy the separate function room, not the main floor,
    // so they never count against the per-slot table capacity (Kevin 2026-10-09).
    .filter((r) => !isPartyHallRow(r.special_requests))
    .map((r) => ({
      minutes: toMinutes(String(r.reservation_time)),
      partySize: Number(r.party_size),
    }));

  const fits = (candidateMin: number): boolean =>
    // The party hall is its own space, so main-floor covers don't gate it — only
    // opening hours and the min-advance window apply.
    (input.allowPartyHall || coversAt(existing, candidateMin, settings.turnoverMinutes) + partySize <= settings.maxCoversPerSlot) &&
    withinHours(hours, dowOfIso(date), candidateMin) &&
    !(dayDelta === 0 && candidateMin < nowMin + settings.minAdvanceMinutes);

  if (fits(reqMin)) return { status: "AVAILABLE", alternatives: none };

  // Requested slot full — look for the nearest alternatives (±interval, growing).
  const step = settings.slotIntervalMinutes;
  const alternatives: { min: number; dist: number }[] = [];
  for (let d = step; d <= 60; d += step) {
    for (const cand of [reqMin - d, reqMin + d]) {
      if (cand >= 0 && cand < 1440 && fits(cand)) alternatives.push({ min: cand, dist: d });
    }
  }
  alternatives.sort((a, b) => a.dist - b.dist || a.min - b.min);
  const picks = alternatives.slice(0, 3).map((a) => fmtHHMM(a.min));
  if (picks.length > 0) return { status: "ALTERNATIVES_AVAILABLE", alternatives: picks };
  return { status: "UNAVAILABLE", alternatives: none };
}

// ---------------------------------------------------------------- create

export interface CreateReservationInput {
  restaurantId: string;
  customerName: string;
  customerPhone: string;
  date: string; // ISO
  time: string; // HH:MM
  partySize: number;
  specialRequests?: string;
  highChair?: boolean;
  accessibility?: boolean;
  occasion?: string;
  seatingPref?: "" | "indoor" | "outdoor";
  source?: string;
  callId?: string | null;
  idempotencyKey?: string | null;
  /** 'unresolved' when the name could not be captured and the booking is held
   * under the caller's phone number (never a guessed name). Defaults to 'provided'. */
  nameStatus?: "provided" | "unresolved";
  /** Flag the row for a human to follow up (e.g. to confirm an unresolved name). */
  needsStaffAttention?: boolean;
  /** Book into the separate party hall / function room: the per-slot main-floor
   * cover limit does not apply (the hall is its own space), so a big group above
   * maxPartySize can be booked directly (Kevin 2026-10-09). The caller is expected
   * to tag specialRequests with "party hall" so it's excluded from floor covers. */
  partyHall?: boolean;
}

/** A reservation that sits in the separate party hall / function room (tagged in
 * special_requests) — excluded from main-floor per-slot cover accounting. */
function isPartyHallRow(specialRequests: unknown): boolean {
  return /party hall/i.test(String(specialRequests ?? ""));
}

export interface CreateReservationResult {
  reservation: Reservation;
  /** True when an identical booking already existed (idempotent / dedup). */
  duplicate: boolean;
}

async function genUniqueRef(tx: Queryable, restaurantId: string, prefix: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const ref = `${prefix}${1000 + Math.floor(Math.random() * 9000)}`;
    const clash = await tx.query(
      `SELECT 1 FROM reservations WHERE restaurant_id = $1 AND public_ref = $2`,
      [restaurantId, ref],
    );
    if (clash.rows.length === 0) return ref;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

/** Thrown when the slot filled between the availability check and creation
 * (spec §7). The caller offers alternatives instead of confirming. */
export class ReservationCapacityError extends Error {
  constructor() {
    super("SLOT_FULL");
    this.name = "ReservationCapacityError";
  }
}

/**
 * Atomically create a reservation. Idempotent on idempotencyKey; the
 * no-dup-active index collapses accidental double-submits; and capacity is
 * REVALIDATED atomically under a per-(restaurant,date) advisory lock so two
 * callers can't both take the last covers between check and create (spec §6-7).
 */
export async function createReservation(
  db: pg.Pool,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  const settings = await getReservationSettings(db, input.restaurantId);
  return withTransaction(db, async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.query(
        `SELECT * FROM reservations WHERE restaurant_id = $1 AND idempotency_key = $2`,
        [input.restaurantId, input.idempotencyKey],
      );
      if (existing.rows[0]) return { reservation: camelRow<Reservation>(existing.rows[0]), duplicate: true };
    }
    // Pre-check an accidental exact-duplicate active booking (common double-submit)
    // so the happy path never trips the unique index / aborts the transaction.
    const dupPre = await tx.query(
      `SELECT * FROM reservations
        WHERE restaurant_id = $1 AND customer_phone = $2 AND reservation_date = $3
          AND reservation_time = $4 AND party_size = $5 AND status = 'CONFIRMED' LIMIT 1`,
      [input.restaurantId, input.customerPhone, input.date, `${input.time}:00`, input.partySize],
    );
    if (dupPre.rows[0]) return { reservation: camelRow<Reservation>(dupPre.rows[0]), duplicate: true };

    // Race-safe capacity (§6-7): serialise creates for this restaurant+date, then
    // re-check the slot's covers atomically before inserting. Prevents two
    // callers both taking the last seats on stale availability.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${input.restaurantId}:${input.date}`]);
    const slot = await tx.query(
      `SELECT reservation_time, party_size, special_requests FROM reservations
        WHERE restaurant_id = $1 AND reservation_date = $2 AND status = 'CONFIRMED'`,
      [input.restaurantId, input.date],
    );
    const reqMin = toMinutes(`${input.time}:00`);
    const covers = slot.rows
      // Party-hall bookings sit in the separate function room — they neither
      // consume main-floor covers nor get blocked by the per-slot limit.
      .filter((r) => !isPartyHallRow(r.special_requests))
      .filter((r) => Math.abs(toMinutes(String(r.reservation_time)) - reqMin) < settings.turnoverMinutes)
      .reduce((sum, r) => sum + Number(r.party_size), 0);
    // A party-hall booking uses the function room's own capacity, so the main-
    // floor per-slot cover limit does not gate it (Kevin 2026-10-09: just book it).
    if (!input.partyHall && covers + input.partySize > settings.maxCoversPerSlot) {
      throw new ReservationCapacityError();
    }

    const ref = await genUniqueRef(tx, input.restaurantId, settings.refPrefix);
    // Savepoint so a race that hits the unique index can be recovered without
    // aborting the whole transaction.
    await tx.query("SAVEPOINT ins");
    try {
      const inserted = await tx.query(
        `INSERT INTO reservations
           (restaurant_id, public_ref, customer_name, customer_phone, reservation_date,
            reservation_time, party_size, special_requests, high_chair, accessibility,
            occasion, seating_pref, source, call_id, idempotency_key,
            name_status, needs_staff_attention)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          input.restaurantId, ref, input.customerName, input.customerPhone, input.date,
          input.time, input.partySize, input.specialRequests ?? "", input.highChair ?? false,
          input.accessibility ?? false, input.occasion ?? "", input.seatingPref ?? "",
          input.source ?? "phone", input.callId ?? null, input.idempotencyKey ?? null,
          input.nameStatus ?? "provided", input.needsStaffAttention ?? false,
        ],
      );
      const reservation = camelRow<Reservation>(inserted.rows[0]!);
      await tx.query(
        `INSERT INTO reservation_audit (reservation_id, action, detail) VALUES ($1, 'created', $2)`,
        [reservation.id, JSON.stringify({ date: input.date, time: input.time, partySize: input.partySize })],
      );
      return { reservation, duplicate: false };
    } catch (err: unknown) {
      await tx.query("ROLLBACK TO SAVEPOINT ins");
      // Duplicate active booking (same phone/date/time/party) -> return the existing one.
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        const dup = await tx.query(
          `SELECT * FROM reservations
            WHERE restaurant_id = $1 AND customer_phone = $2 AND reservation_date = $3
              AND reservation_time = $4 AND party_size = $5 AND status = 'CONFIRMED'
            LIMIT 1`,
          [input.restaurantId, input.customerPhone, input.date, `${input.time}:00`, input.partySize],
        );
        if (dup.rows[0]) return { reservation: camelRow<Reservation>(dup.rows[0]), duplicate: true };
      }
      throw err;
    }
  });
}

// ---------------------------------------------------------------- find / modify / cancel

/** Active (CONFIRMED) reservations for a caller, optionally on a date. */
export async function findReservations(
  db: Queryable,
  restaurantId: string,
  phone: string,
  date?: string,
): Promise<Reservation[]> {
  const res = await db.query(
    `SELECT * FROM reservations
      WHERE restaurant_id = $1 AND customer_phone = $2 AND status = 'CONFIRMED'
        AND ($3::date IS NULL OR reservation_date = $3)
      ORDER BY reservation_date, reservation_time`,
    [restaurantId, phone, date ?? null],
  );
  return camelRows<Reservation>(res.rows);
}

export async function getReservationByRef(
  db: Queryable,
  restaurantId: string,
  ref: string,
): Promise<Reservation | null> {
  const res = await db.query(
    `SELECT * FROM reservations WHERE restaurant_id = $1 AND upper(public_ref) = upper($2) LIMIT 1`,
    [restaurantId, ref],
  );
  return res.rows[0] ? camelRow<Reservation>(res.rows[0]) : null;
}

/** Re-read a reservation straight from the database by its id. The spoken
 * confirmation and the SMS are built from THIS persisted record — not from the
 * conversational state, the LLM, or a prior revision — so what the caller hears
 * and is texted is exactly what was saved (Kevin 2026-10-10 DB consistency gate). */
export async function getReservationById(
  db: Queryable,
  id: string,
): Promise<Reservation | null> {
  const res = await db.query(`SELECT * FROM reservations WHERE id = $1 LIMIT 1`, [id]);
  return res.rows[0] ? camelRow<Reservation>(res.rows[0]) : null;
}

export async function cancelReservation(
  db: pg.Pool,
  reservationId: string,
  actor = "phone",
): Promise<Reservation | null> {
  return withTransaction(db, async (tx) => {
    const res = await tx.query(
      `UPDATE reservations SET status = 'CANCELLED', updated_at = now()
        WHERE id = $1 AND status = 'CONFIRMED' RETURNING *`,
      [reservationId],
    );
    if (!res.rows[0]) return null;
    await tx.query(
      `INSERT INTO reservation_audit (reservation_id, action, actor) VALUES ($1, 'cancelled', $2)`,
      [reservationId, actor],
    );
    return camelRow<Reservation>(res.rows[0]);
  });
}

export interface ModifyChanges {
  date?: string;
  time?: string;
  partySize?: number;
  customerName?: string;
  specialRequests?: string;
}

/**
 * Apply changes to an existing booking atomically. If date/time/party change,
 * availability is re-checked for the new slot first; on no availability the
 * booking is left untouched and the availability result is returned.
 */
export async function modifyReservation(
  db: pg.Pool,
  params: {
    reservationId: string;
    changes: ModifyChanges;
    hours: RestaurantHoursRow[];
    settings: ReservationSettings;
    timezone: string;
    now: Date;
    actor?: string;
  },
): Promise<{ reservation: Reservation } | { unavailable: AvailabilityResult } | { notFound: true }> {
  const current = await db.query(`SELECT * FROM reservations WHERE id = $1 AND status = 'CONFIRMED'`, [
    params.reservationId,
  ]);
  if (!current.rows[0]) return { notFound: true };
  const res = camelRow<Reservation>(current.rows[0]);
  const c = params.changes;
  const newDate = c.date ?? res.reservationDate;
  const newTime = c.time ?? res.reservationTime.slice(0, 5);
  const newParty = c.partySize ?? res.partySize;

  if (c.date || c.time || c.partySize) {
    const avail = await checkAvailability({
      db, restaurantId: res.restaurantId, hours: params.hours, settings: params.settings,
      timezone: params.timezone, now: params.now, date: newDate, time: newTime,
      partySize: newParty, excludeReservationId: res.id,
    });
    if (avail.status !== "AVAILABLE") return { unavailable: avail };
  }

  return withTransaction(db, async (tx) => {
    const updated = await tx.query(
      `UPDATE reservations SET
         reservation_date = $2, reservation_time = $3, party_size = $4,
         customer_name = COALESCE($5, customer_name),
         special_requests = COALESCE($6, special_requests), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [res.id, newDate, newTime, newParty, c.customerName ?? null, c.specialRequests ?? null],
    );
    await tx.query(
      `INSERT INTO reservation_audit (reservation_id, action, detail, actor) VALUES ($1, 'modified', $2, $3)`,
      [res.id, JSON.stringify(c), params.actor ?? "phone"],
    );
    return { reservation: camelRow<Reservation>(updated.rows[0]!) };
  });
}
