import type { RestaurantHoursRow } from "../types";

/**
 * Opening-hours logic with overnight support.
 * Meatbox really trades 5:00pm – 1:00am, so a window whose closes_at is
 * earlier than its opens_at spills into the following day: at 00:30 the
 * restaurant is open under the PREVIOUS day's window.
 */

export interface LocalClock {
  dayOfWeek: number; // 0 = Sunday
  minutesOfDay: number; // 0..1439 in the restaurant's timezone
  dateKey: string; // YYYY-MM-DD in the restaurant's timezone
}

export function localClock(now: Date, timezone: string): LocalClock {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOfWeek = dayNames.indexOf(String(parts.weekday).slice(0, 3));
  const hour = Number(parts.hour) % 24; // Intl can emit "24" for midnight
  return {
    dayOfWeek,
    minutesOfDay: hour * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function parseTimeToMinutes(time: string | null): number | null {
  if (!time) return null;
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export interface OpenState {
  open: boolean;
  /** Human description like "5:00 pm – 1:00 am" for today, or reason closed. */
  todayWindow: string;
  /** Minutes until close when open, null otherwise. */
  minutesUntilClose: number | null;
}

function windowFor(rows: RestaurantHoursRow[], dayOfWeek: number) {
  const row = rows.find((r) => r.dayOfWeek === dayOfWeek);
  if (!row || row.isClosed) return null;
  const opens = parseTimeToMinutes(row.opensAt);
  const closes = parseTimeToMinutes(row.closesAt);
  if (opens === null || closes === null) return null;
  return { opens, closes, overnight: closes <= opens };
}

export function formatMinutes(mins: number): string {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const suffix = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}:00 ${suffix}` : `${h12}:${m.toString().padStart(2, "0")} ${suffix}`;
}

/** Is the restaurant open at the given instant? */
export function openStateAt(rows: RestaurantHoursRow[], now: Date, timezone: string): OpenState {
  const clock = localClock(now, timezone);
  const today = windowFor(rows, clock.dayOfWeek);
  const yesterday = windowFor(rows, (clock.dayOfWeek + 6) % 7);

  // Yesterday's overnight tail (e.g. Monday 00:30 under Sunday's 5pm–1am window)
  if (yesterday?.overnight && clock.minutesOfDay < yesterday.closes) {
    return {
      open: true,
      todayWindow: describeDay(rows, clock.dayOfWeek),
      minutesUntilClose: yesterday.closes - clock.minutesOfDay,
    };
  }

  if (today) {
    const closesAbs = today.overnight ? today.closes + 1440 : today.closes;
    if (clock.minutesOfDay >= today.opens && clock.minutesOfDay < closesAbs) {
      return {
        open: true,
        todayWindow: describeDay(rows, clock.dayOfWeek),
        minutesUntilClose: closesAbs - clock.minutesOfDay,
      };
    }
  }

  return { open: false, todayWindow: describeDay(rows, clock.dayOfWeek), minutesUntilClose: null };
}

export function describeDay(rows: RestaurantHoursRow[], dayOfWeek: number): string {
  const w = windowFor(rows, dayOfWeek);
  if (!w) return "closed today";
  return `${formatMinutes(w.opens)} – ${formatMinutes(w.closes)}`;
}

export function describeWeek(rows: RestaurantHoursRow[]): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `${names[d]}: ${describeDay(rows, d)}`)
    .join("\n");
}

/**
 * Validate a requested pickup/arrival time.
 * Returns { ok } or { ok: false, reason } with a caller-friendly message.
 */
export function validateRequestedTime(params: {
  rows: RestaurantHoursRow[];
  timezone: string;
  now: Date;
  requested: Date;
  minPrepMinutes: number;
  maxFutureHours: number;
  futureOrdersEnabled: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const { rows, timezone, now, requested, minPrepMinutes, maxFutureHours } = params;
  const diffMinutes = (requested.getTime() - now.getTime()) / 60000;
  if (diffMinutes < 0) {
    return { ok: false, reason: "That time has already passed." };
  }
  if (diffMinutes < minPrepMinutes) {
    return {
      ok: false,
      reason: `We need at least ${minPrepMinutes} minutes to prepare an order.`,
    };
  }
  if (diffMinutes > 60 && !params.futureOrdersEnabled) {
    return { ok: false, reason: "We can only take orders for as soon as possible right now." };
  }
  if (diffMinutes > maxFutureHours * 60) {
    return {
      ok: false,
      reason: `We can only take orders up to ${maxFutureHours} hours ahead.`,
    };
  }
  const state = openStateAt(rows, requested, timezone);
  if (!state.open) {
    return { ok: false, reason: "The kitchen is closed at that time." };
  }
  return { ok: true };
}
