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

/** Shift an ISO date (YYYY-MM-DD) by a number of days, returning ISO. Used for a
 * relative "move it a week later/earlier" change without restating the date. */
export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const r = addDays(y!, m!, d!, days);
  return iso(r.year, r.month, r.day);
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

  // "a week today" / "today week" = 7 days out; "a week tomorrow" / "tomorrow week"
  // = 8 — resolve these BEFORE the bare today/tomorrow returns below (else "a week
  // today" is wrongly read as today).
  if (/\b(a week (from )?today|today week)\b/.test(t)) {
    const d = addDays(today.year, today.month, today.day, 7);
    return finalise(iso(d.year, d.month, d.day));
  }
  if (/\b(a week (from )?tomorrow|tomorrow week)\b/.test(t)) {
    const d = addDays(today.year, today.month, today.day, 8);
    return finalise(iso(d.year, d.month, d.day));
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

  // How many weeks OUT the caller means: "next week"/"following week" = 1; "in two
  // weeks('/ time)", "a fortnight", "the week after next" = 2; "in N weeks" = N.
  // (Kevin 2026-10-05: "next week on Wednesday" AND "in two weeks' time on Thursday"
  // both booked THIS week.) Plain "next <weekday>" (no week word) stays the coming one.
  const WK_NUM: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const inWeeks = t.match(/\b(?:in\s+)?(?:about\s+|around\s+|roughly\s+)?(a|one|two|three|four|five|six|\d{1,2})\s+weeks?\b/);
  // "(in|after) a month" / "N months" — approximated as 4 weeks each so "a month on
  // Wednesday" lands ~a month out on that weekday, not the coming one (Kevin 2026-10-07).
  const inMonths = t.match(/\b(?:in\s+|after\s+)?(?:about\s+|around\s+|roughly\s+)?(a|one|two|three|four|five|six|\d{1,2})\s+months?\b/);
  let weeksAhead = 0;
  if (/\bfortnight\b/.test(t) || /\bweek after next\b/.test(t)) weeksAhead = 2;
  else if (inWeeks) weeksAhead = WK_NUM[inWeeks[1]!] ?? (parseInt(inWeeks[1]!, 10) || 0);
  else if (inMonths) weeksAhead = (WK_NUM[inMonths[1]!] ?? (parseInt(inMonths[1]!, 10) || 1)) * 4;
  else if (/\bafter next\b/.test(t)) weeksAhead = 1; // "the Wednesday after next" = the one after the coming
  else if (/\b(next week|following week|the week after)\b/.test(t)) weeksAhead = 1;

  // "this weekend" / "next weekend" / "the weekend" — resolve to the Saturday (the
  // spoken read-back lets the caller switch to Sunday if they meant it). (Battery 2026-10-05.)
  if (/\bweekend\b/.test(t)) {
    let ahead = (6 - today.dow + 7) % 7; // coming Saturday (0 = today if Sat)
    if (/\b(next|following)\s+weekend\b/.test(t)) ahead += 7;
    else ahead += weeksAhead * 7;
    if (ahead === 0 && /\b(next|following)\b/.test(t)) ahead = 7;
    const d = addDays(today.year, today.month, today.day, ahead);
    return finalise(iso(d.year, d.month, d.day));
  }
  // "the 14th" / "14th" / "14th of October" / "October 14". Compute this BEFORE the
  // weekday block so an explicit calendar day wins over a bare weekday. First strip
  // DURATION phrases so "2 weeks" / "two weeks" can't leak their count into the
  // day-of-month (audit 2026-10-07: "in 2 weeks on the 14th" read day = 2).
  const tDay = t
    .replace(
      /\b(?:\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:weeks?|days?|months?|years?|fortnights?|hours?|minutes?|mins?)\b/g,
      " ",
    )
    // Strip CLOCK TIMES so an hour digit ("7" in "7:00 pm") can never leak into the
    // day-of-month (live call 2026-10-09: "after two weeks … 7pm" booked the 7th).
    .replace(/\b\d{1,2}\s*[:.h]\s*\d{2}\s*(?:a\.?m\.?|p\.?m\.?)?\b/g, " ") // 7:00 / 7.30 / 7h30 / 7:00pm
    .replace(/\b\d{1,2}\s+\d{2}\s*(?:a\.?m\.?|p\.?m\.?)\b/g, " ")          // "7 00 pm" (STT dropped the colon)
    .replace(/\b\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/g, " ")                 // 7pm / 7 am
    .replace(/\b\d{1,2}\s*o'?clock\b/g, " ")                              // 7 o'clock
    .replace(/\bat\s+\d{1,2}\b/g, " ")                                    // "at 7"
    .replace(/\s+/g, " ")
    .trim();
  let dayNum: number | null = null;
  let monthNum: number | null = null;
  const monthWord = Object.keys(MONTHS).find((mn) => new RegExp(`\\b${mn}\\b`).test(t));
  if (monthWord) monthNum = MONTHS[monthWord]!;
  const ordWord = Object.keys(ORDINALS).find((o) => new RegExp(`\\b${o}\\b`).test(tDay));
  const dayDigits = tDay.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (ordWord) dayNum = ORDINALS[ordWord]!;
  else if (dayDigits) dayNum = Number(dayDigits[1]);
  // An EXPLICIT day-of-month is present if an ordinal word, an ordinal-suffixed
  // number ("14th"), or a month name beside a number was said. When one is, it
  // overrides a bare weekday ("Wednesday the 14th" must honour the 14th, not silently
  // book the coming Wednesday and drop the number — audit 2026-10-07).
  const hasDayOfMonth =
    Boolean(ordWord) ||
    /\b\d{1,2}(?:st|nd|rd|th)\b/.test(tDay) ||
    (Boolean(monthWord) && /\b\d{1,2}\b/.test(tDay));

  // Weekday, with optional this / next / coming / following, or a trailing "week" —
  // but only when no explicit day-of-month was given (see hasDayOfMonth above).
  const wdMatch = t.match(/\b(this|next|coming|following)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b(\s+week)?/);
  if (wdMatch && !hasDayOfMonth) {
    const modifier = wdMatch[1];
    const targetDow = WEEKDAYS[wdMatch[2]!]!;
    const weekSuffix = Boolean(wdMatch[3]);
    // "<weekday> week" / "following <weekday>" imply one week out when no explicit
    // count was given; otherwise use the counted weeks.
    let weeks = weeksAhead;
    if (weeks === 0 && (weekSuffix || modifier === "following")) weeks = 1;
    let ahead = (targetDow - today.dow + 7) % 7; // 0..6, coming occurrence (0 = today)
    // Named day is today with no week count but a "next" -> the next occurrence.
    if (ahead === 0 && weeks === 0 && modifier === "next") ahead = 7;
    ahead += weeks * 7;
    const d = addDays(today.year, today.month, today.day, ahead);
    return finalise(iso(d.year, d.month, d.day));
  }

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
    // "next month (the) 14th" / "the 14th of next month" — no month NAME, but "next
    // month" means the month after this one (Kevin 2026-10-08: "change to next month
    // the 14th" was read as this month / ignored).
    if (monthNum === null && /\bnext month\b/.test(t)) {
      const nm = today.month === 12 ? 1 : today.month + 1;
      const ny = today.month === 12 ? today.year + 1 : today.year;
      if (dayNum > daysInMonth(ny, nm)) return { error: "INVALID_DATE" };
      return finalise(iso(ny, nm, dayNum));
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

  // DEFINITE relative offset with no weekday and no day-of-month — anchored to today
  // so it IS a specific day: "three weeks from now / from today", "two weeks later",
  // "same day next week", "a week today / a week from tomorrow". Resolve to today +
  // the offset (same weekday). The brain then GROUNDS it ("that's Saturday the 31st?").
  // NOTE: "in two weeks" / "after two weeks" (vague — no "from now/later/same day")
  // deliberately stay undefined so the brain asks which day (Kevin 2026-10-09 entry 95).
  const definite = /\b(from (now|today)|later)\b/.test(t) || /\bsame day (next|the following) week\b/.test(t) || /\ba week (from )?(today|tomorrow)\b/.test(t);
  if (definite) {
    let days = weeksAhead * 7;
    if (/\bsame day (next|the following) week\b/.test(t) || /\ba week (from )?today\b/.test(t)) days = 7;
    else if (/\ba week (from )?tomorrow\b/.test(t)) days = 8;
    if (days > 0) {
      const d = addDays(today.year, today.month, today.day, days);
      return finalise(iso(d.year, d.month, d.day));
    }
  }
  return { error: "INVALID_DATE" };
}

export interface TimeResult {
  time?: string; // HH:MM 24h
  ambiguous?: { label: string; time: string }[];
  error?: "INVALID_TIME";
}

/** The restaurant's opening window in minutes-from-midnight, close possibly past
 * 24:00 to express a past-midnight close (17:00–01:00 → { openMin:1020, closeMin:1500 }).
 * When supplied, a bare ambiguous hour is resolved to the reading that falls inside it —
 * so "half past eleven" at an evening venue is 23:30, not a closed 11:30 AM. */
export interface OpeningWindow { openMin: number; closeMin: number }

/**
 * Resolve a spoken time to 24h "HH:MM". Bare evening-restaurant hours default to
 * PM (spec §8: "seven" -> 19:00); genuine AM/PM ambiguity returns candidates.
 * With an OpeningWindow, a bare ambiguous hour (no am/pm) is disambiguated to the
 * reading that lands within opening hours (Kevin 2026-10-10 live call: "half past
 * eleven" looped because it read as 11:30 AM, outside the 5 PM–1 AM window).
 */
export function normaliseTime(input: string, win?: OpeningWindow): TimeResult {
  // Keep "." / ":" / "h" so "7.30" / "7:30" / "7h30" parse; drop other punctuation.
  let t = input.toLowerCase().replace(/[,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return { error: "INVALID_TIME" };
  // Approximate "-ish" glued to an hour → the hour ("eightish"/"seven-ish" → "eight").
  // ("eight-ish" already splits on the hyphen; this handles the run-together form.)
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})[-\s]?ish\b/g, "$1");
  // De-glue a time suffix stuck to the hour — "8pm"/"7p.m."/"10am" (STT and callers
  // often run them together) → "8 pm" so both the hour and am/pm parse.
  t = t.replace(/(\d)\s*((?:a|p)\.?m\.?)\b/gi, "$1 $2").replace(/\s+/g, " ").trim();
  // "ten minutes past six" → "ten past six" BEFORE the duration-strip (else it eats
  // "ten minutes" and drops the offset; Kevin 2026-10-07: "10 mins extra" → 6:10).
  t = t.replace(/\b(quarter|half|\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\s+(?:minutes?|mins?)\s+(past|to|after|before|till)\b/gi, "$1 $2").replace(/\s+/g, " ").trim();
  // Strip DURATION phrases first so "in (about) two weeks time" / "three days" are
  // never read as a clock time ("two" -> 2 PM). A number glued to weeks/days/months/
  // etc. is a duration, not an hour (live calls 2026-10-05/06: "two weeks" -> 2 PM).
  t = t
    .replace(/\b(a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+(weeks?|days?|months?|years?|fortnights?|hours?|minutes?|mins?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return { error: "INVALID_TIME" };
  // NB the group boundaries matter: "/\bmidday|noon\b/" (no \b before noon) matches
  // the "noon" inside "after·noon" and silently returned 12:00 for "7 PM in the
  // afternoon" (live call CA46547d: 7 PM -> 12 PM). Anchor both words.
  // Only short-circuit BARE noon/midday/midnight. With a relative-minute modifier
  // ("quarter past midday", "ten past noon", "quarter to midnight") let it fall
  // through to the rel/hmin logic below (which maps noon/midday->12, midnight->0),
  // so the offset isn't dropped (audit 2026-10-07: "quarter past midday" -> 12:00).
  const hasRelMinuteCue = /\b(past|to|till|after|before|quarter|half)\b/.test(t);
  if (!hasRelMinuteCue) {
    if (/\b(midday|noon)\b/.test(t)) return { time: "12:00" };
    if (/\bmidnight\b/.test(t)) return { time: "00:00" };
  }

  // Detect AM/PM on a dot-normalised copy so "p.m." / "a.m." (how the STT often
  // renders it) are caught as well as "pm" / "am".
  const td = t.replace(/\./g, " ").replace(/\s+/g, " ");
  const pm = /\b(pm|p m|tonight|evening|arvo|afternoon|night)\b/.test(td);
  const am = /\b(am|a m|morning|breakfast)\b/.test(td);

  let hour: number | null = null;
  let minute = 0;

  // Spoken minute values for "ten past six", "twenty to eight", "seven thirty".
  const MINS: Record<string, number> = {
    quarter: 15, half: 30, five: 5, ten: 10, fifteen: 15, twenty: 20,
    "twenty five": 25, thirty: 30, "thirty five": 35, forty: 40,
    "forty five": 45, fifty: 50, "fifty five": 55, "oh five": 5, "o five": 5,
  };
  const HOURW = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midday|midnight)";
  const MINW = "(o'?clock|o clock|quarter|half|twenty[\\s-]five|thirty[\\s-]five|forty[\\s-]five|fifty[\\s-]five|oh five|five|ten|fifteen|twenty|thirty|forty|fifty|[0-5]\\d)";
  const hourVal = (s: string): number | null => (/^\d{1,2}$/.test(s) ? Number(s) : (NUM_WORDS[s] ?? null));
  const minVal = (s: string): number | null => {
    const w = s.replace(/[-]/g, " ").trim();
    if (/^\d{1,2}$/.test(w)) return Number(w);
    return MINS[w] ?? null;
  };

  const hm = t.match(/\b(\d{1,2})[:.h](\d{2})\b/); // 7:30, 7.30, 7h30
  // "<min> past|after|to|till <hour>" — half past 7, quarter to eight, ten past six.
  const rel = t.match(new RegExp(`\\b(quarter|half|twenty[\\s-]five|thirty[\\s-]five|forty[\\s-]five|fifty[\\s-]five|five|ten|fifteen|twenty|thirty|forty|fifty|\\d{1,2})\\s+(past|after|to|till|before)\\s+${HOURW}\\b`));
  // "<hour> <min>" — seven thirty, six forty five, eight o'clock.
  const hmin = t.match(new RegExp(`\\b${HOURW}\\s+${MINW}\\b`));
  // British "half <hour>" (= half past) — half seven = 7:30.
  const halfH = t.match(new RegExp(`\\bhalf\\s+${HOURW}\\b`));

  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  } else if (rel && minVal(rel[1]!) !== null && hourVal(rel[3]!) !== null) {
    const m = minVal(rel[1]!)!;
    let h = hourVal(rel[3]!)!;
    if (/^(to|till|before)$/.test(rel[2]!)) {
      minute = (60 - m) % 60;
      // The hour BEFORE the stated one. Midnight (0) wraps to 23 — "quarter to
      // midnight" is 23:45, not 11:45 (the 12h formula alone gave 11). Noon (12) and
      // 1..12 keep the 12h mapping ("to noon"->11:45, "to one"->12:45).
      h = h === 0 ? 23 : ((h + 11) % 12 || 12);
    }
    else minute = m;
    hour = h;
  } else if (hmin && hourVal(hmin[1]!) !== null) {
    hour = hourVal(hmin[1]!)!;
    const mw = hmin[2]!.replace(/[-]/g, " ");
    minute = /o'?clock|o clock/.test(mw) ? 0 : (minVal(mw) ?? 0);
  } else if (halfH && hourVal(halfH[1]!) !== null) {
    hour = hourVal(halfH[1]!)!;
    minute = 30;
  } else {
    // Bare hour: a digit, or a number word ("seven", "around seven").
    const hOnly = t.match(/\b(\d{1,2})\b/);
    const word = Object.keys(NUM_WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (hOnly) hour = Number(hOnly[1]);
    else if (word) hour = NUM_WORDS[word]!;
    // Standalone "half"/"quarter past" with no hour is too ambiguous — left to re-ask.
  }

  if (hour === null || Number.isNaN(hour) || minute > 59) return { error: "INVALID_TIME" };
  if (hour < 0 || hour > 23) return { error: "INVALID_TIME" };

  const fmt = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  if (hour === 0) return { time: fmt(0, minute) };
  if (hour >= 13) return { time: fmt(hour, minute) }; // already 24h
  if (pm) return { time: fmt(hour === 12 ? 12 : hour + 12, minute) };
  if (am) return { time: fmt(hour === 12 ? 0 : hour, minute) };

  // Bare hour, no AM/PM. When we know the opening window, pick the reading (AM vs PM,
  // or noon vs midnight for 12) that lands INSIDE it — so an evening venue reads
  // "eleven"/"half past eleven" as 23:00/23:30 and "twelve" as midnight, never a
  // closed lunchtime. If neither reading fits (or no window), fall back to the
  // evening-default heuristic below.
  if (win) {
    const inWin = (h: number) => {
      const m = h * 60 + minute;
      return (m >= win.openMin && m < win.closeMin) || (m + 1440 >= win.openMin && m + 1440 < win.closeMin);
    };
    const candidates = hour === 12 ? [12, 0] : [hour + 12, hour];
    for (const h of candidates) if (h <= 23 && inWin(h)) return { time: fmt(h, minute) };
  }
  // Evening-default: 1–10 -> PM (13:00–22:00); 11/12 stay as spoken (11 AM / noon are
  // the realistic lunch reads absent an opening window). Read-back still guards it.
  if (hour === 12) return { time: fmt(12, minute) };
  if (hour === 11) return { time: fmt(11, minute) };
  return { time: fmt(hour + 12, minute) };
}
