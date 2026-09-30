/**
 * Deterministic date & time normalisation for reservations (spec §7, §8).
 *
 * The LLM is NEVER trusted to resolve a relative date — it only passes the
 * caller's raw words ("this Friday", "the 14th", "around seven") to these pure
 * functions, which resolve everything to an ISO date / 24h time in the
 * restaurant's own timezone. Ambiguous input returns candidates to clarify;
 * nothing is silently guessed.
 */

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, noon: 12, midday: 12, midnight: 0,
};

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, "twenty-first": 21, "twenty-second": 22,
  "twenty-third": 23, "twenty-fourth": 24, "twenty-fifth": 25, "twenty-sixth": 26,
  "twenty-seventh": 27, "twenty-eighth": 28, "twenty-ninth": 29, thirtieth: 30,
  "thirty-first": 31,
};

const MONTH_LEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) return 29;
  return MONTH_LEN[month1 - 1]!;
}

function iso(year: number, month1: number, day: number): string {
  return `${year}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Today's date parts in a given IANA timezone (no time component). */
export function localToday(now: Date, timezone: string): { year: number; month: number; day: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const dow = WEEKDAYS[String(parts.weekday).toLowerCase()] ?? 0;
  return { year, month, day, dow };
}

/** Add whole days to a Y/M/D triple (calendar-correct, timezone-agnostic). */
function addDays(y: number, m: number, d: number, add: number): { year: number; month: number; day: number } {
  // Use a UTC anchor at noon so the calendar date never shifts.
  const base = Date.UTC(y, m - 1, d, 12, 0, 0);
  const shifted = new Date(base + add * 86_400_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function diffDays(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  return Math.round((Date.UTC(ay!, am! - 1, ad!) - Date.UTC(by!, bm! - 1, bd!)) / 86_400_000);
}

export interface DateResult {
  date?: string; // YYYY-MM-DD
  ambiguous?: { label: string; date: string }[];
  error?: "INVALID_DATE" | "PAST" | "TOO_FAR";
}

export interface NormaliseDateOpts {
  now: Date;
  timezone: string;
  maxAdvanceDays?: number;
}

/**
 * Resolve a spoken/typed date to an ISO date in the restaurant timezone.
 * Returns { date } when unambiguous, { ambiguous } to clarify, or { error }.
 */
export function normaliseDate(input: string, opts: NormaliseDateOpts): DateResult {
  const t = input.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { error: "INVALID_DATE" };
  const today = localToday(opts.now, opts.timezone);
  const todayIso = iso(today.year, today.month, today.day);
  const maxDays = opts.maxAdvanceDays ?? 120;

  const finalise = (dateIso: string): DateResult => {
    const delta = diffDays(dateIso, todayIso);
    if (delta < 0) return { error: "PAST" };
    if (delta > maxDays) return { error: "TOO_FAR" };
    return { date: dateIso };
  };

  // ISO date straight through.
  const isoMatch = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number) as [number, number, number, number];
    if (m! >= 1 && m! <= 12 && d! >= 1 && d! <= daysInMonth(y!, m!)) return finalise(iso(y!, m!, d!));
    return { error: "INVALID_DATE" };
  }

  // today / tonight / tomorrow / (day after tomorrow).
  if (/\b(today|tonight|this evening|this arvo|this afternoon)\b/.test(t)) return finalise(todayIso);
  if (/\b(day after tomorrow|overmorrow)\b/.test(t)) {
    const d = addDays(today.year, today.month, today.day, 2);
    return finalise(iso(d.year, d.month, d.day));
  }
  if (/\b(tomorrow|tomoz|tmrw)\b/.test(t)) {
    const d = addDays(today.year, today.month, today.day, 1);
    return finalise(iso(d.year, d.month, d.day));
  }

  // Weekday, with optional this / next / "week" (Friday week = Friday next week).
  const wdMatch = t.match(/\b(this|next|coming)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b(\s+week)?/);
  if (wdMatch) {
    const modifier = wdMatch[1];
    const targetDow = WEEKDAYS[wdMatch[2]!]!;
    const weekSuffix = Boolean(wdMatch[3]);
    let ahead = (targetDow - today.dow + 7) % 7; // 0..6, 0 = today
    // Bare / "this" / "coming" weekday = the upcoming one (today counts as 0).
    if (ahead === 0 && (modifier === "next" || weekSuffix)) ahead = 7;
    if (modifier === "next" || weekSuffix) {
      // "next Friday" / "Friday week" = the occurrence in the FOLLOWING week.
      if (ahead <= 6 && ahead !== 7) ahead += 7;
    }
    const d = addDays(today.year, today.month, today.day, ahead);
    return finalise(iso(d.year, d.month, d.day));
  }

  // "the 14th" / "14th" / "14th of October" / "October 14".
  let dayNum: number | null = null;
  let monthNum: number | null = null;
  const monthWord = Object.keys(MONTHS).find((mn) => new RegExp(`\\b${mn}\\b`).test(t));
  if (monthWord) monthNum = MONTHS[monthWord]!;
  const ordWord = Object.keys(ORDINALS).find((o) => new RegExp(`\\b${o}\\b`).test(t));
  const dayDigits = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (ordWord) dayNum = ORDINALS[ordWord]!;
  else if (dayDigits) dayNum = Number(dayDigits[1]);

  if (dayNum && dayNum >= 1 && dayNum <= 31) {
    // day/month numeric like 3/10 (AU day-first) when two numbers present.
    const dm = t.match(/\b(\d{1,2})\s*[/\-]\s*(\d{1,2})\b/);
    if (dm) {
      const dd = Number(dm[1]);
      const mm = Number(dm[2]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(today.year, mm)) {
        let year = today.year;
        if (diffDays(iso(year, mm, dd), todayIso) < 0) year += 1;
        return finalise(iso(year, mm, dd));
      }
    }
    const month = monthNum ?? today.month;
    let year = today.year;
    if (dayNum > daysInMonth(year, month)) return { error: "INVALID_DATE" };
    // If no month named and the day already passed this month, roll to next month.
    if (!monthNum && diffDays(iso(year, month, dayNum), todayIso) < 0) {
      const nm = month === 12 ? 1 : month + 1;
      const ny = month === 12 ? year + 1 : year;
      if (dayNum > daysInMonth(ny, nm)) return { error: "INVALID_DATE" };
      return finalise(iso(ny, nm, dayNum));
    }
    if (monthNum && diffDays(iso(year, month, dayNum), todayIso) < 0) year += 1;
    return finalise(iso(year, month, dayNum));
  }

  return { error: "INVALID_DATE" };
}

export interface TimeResult {
  time?: string; // HH:MM 24h
  ambiguous?: { label: string; time: string }[];
  error?: "INVALID_TIME";
}

/**
 * Resolve a spoken time to 24h "HH:MM". Bare evening-restaurant hours default to
 * PM (spec §8: "seven" -> 19:00); genuine AM/PM ambiguity returns candidates.
 */
export function normaliseTime(input: string): TimeResult {
  // Keep "." / ":" / "h" so "7.30" / "7:30" / "7h30" parse; drop other punctuation.
  const t = input.toLowerCase().replace(/[,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { error: "INVALID_TIME" };
  if (/\bmidday|noon\b/.test(t)) return { time: "12:00" };
  if (/\bmidnight\b/.test(t)) return { time: "00:00" };

  const pm = /\b(pm|p m|tonight|evening|arvo|afternoon|night)\b/.test(t);
  const am = /\b(am|a m|morning|breakfast)\b/.test(t);

  let hour: number | null = null;
  let minute = 0;

  const hm = t.match(/\b(\d{1,2})[:.h](\d{2})\b/); // 7:30, 7.30, 7h30
  const hOnly = t.match(/\b(\d{1,2})\b/);
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  } else if (hOnly) {
    hour = Number(hOnly[1]);
  } else {
    // number words: "seven", "half seven", "quarter past seven"
    const word = Object.keys(NUM_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (word) hour = NUM_WORDS[word]!;
    if (/\bhalf\b/.test(t)) minute = 30;
    else if (/\bquarter past|quarter after\b/.test(t)) minute = 15;
    else if (/\bquarter to\b/.test(t) && hour !== null) { minute = 45; hour = (hour + 11) % 12 || 12; }
  }

  if (hour === null || Number.isNaN(hour) || minute > 59) return { error: "INVALID_TIME" };
  if (hour < 0 || hour > 23) return { error: "INVALID_TIME" };

  const fmt = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (hour === 0) return { time: fmt(0, minute) };
  if (hour >= 13) return { time: fmt(hour, minute) }; // already 24h
  if (pm) return { time: fmt(hour === 12 ? 12 : hour + 12, minute) };
  if (am) return { time: fmt(hour === 12 ? 0 : hour, minute) };

  // Bare hour, no AM/PM: an evening/late venue almost always means PM. 1–10 -> PM
  // (13:00–22:00), 11/12 stay as spoken (11 AM / noon are the realistic lunch
  // reads). Confirmation read-back still lets the caller catch it.
  if (hour === 12) return { time: fmt(12, minute) };
  if (hour === 11) return { time: fmt(11, minute) };
  return { time: fmt(hour + 12, minute) };
}
