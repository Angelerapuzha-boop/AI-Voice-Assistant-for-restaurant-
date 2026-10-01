import type pg from "pg";
import type { Reservation, ReservationSettings, RestaurantHoursRow } from "../types";
import {
  cancelReservation,
  checkAvailability,
  createReservation,
  findReservations,
  modifyReservation,
  ReservationCapacityError,
} from "../domain/reservations";
import { enqueueNotification } from "../domain/notifications";
import { localToday, normaliseDate, normaliseTime } from "../domain/reservation-time";
import {
  detectInfoQuery,
  detectIntent,
  detectSeating,
  detectSpecialRequest,
  interpretPartySize,
  isFoodOrderAttempt,
  isNo,
  isYes,
  numberWord,
  parseName,
  parsePartySize,
  parsePhone,
} from "./reservation-parse";

export interface ReservationContext {
  db: pg.Pool;
  restaurantId: string;
  restaurantName: string;
  hours: RestaurantHoursRow[];
  settings: ReservationSettings;
  timezone: string;
  now: () => Date;
  callerPhone?: string;
  callId?: string;
  customerSmsEnabled?: boolean;
  ownerAlertNumber?: string;
  /** For the info layer (spec: factual visiting info, never invented). */
  address?: string;
  phoneDisplay?: string;
}

export type ReservationState =
  | "GREETING"
  | "COLLECT_DATE"
  | "COLLECT_TIME"
  | "COLLECT_PARTY_SIZE"
  | "CONFIRM_PARTY"
  | "OFFER_ALTERNATIVES"
  | "COLLECT_NAME"
  | "COLLECT_PHONE"
  | "CONFIRM_DETAILS"
  | "CONFIRMED"
  | "POST_CONFIRM"
  | "FIND_BOOKING"
  | "CANCEL_CONFIRM"
  | "MODIFY_WHAT"
  | "ESCALATION"
  | "END";

interface Draft {
  date?: string;
  time?: string;
  partySize?: number;
  name?: string;
  phone?: string;
  specialRequests?: string;
  seatingPref?: "" | "indoor" | "outdoor";
}

export interface ReservationTurn {
  say: string;
  kind: string;
  endCall?: boolean;
}

/** A snapshot of the machine's internals for per-turn debug logging (spec §18). */
export interface ReservationDebug {
  state: ReservationState;
  draft: Draft;
  pendingParty?: number;
  ambiguousParty?: number[];
  reasks: { date: number; time: number; party: number; name: number; phone: number };
}

// ---------------------------------------------------------------- speech helpers

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
];

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "2026-10-03" -> "Saturday the 3rd of October". */
export function speakDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
  const ord = ((n: number) => {
    if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
    return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
  })(d!);
  return `${WEEKDAY_NAMES[dow]} the ${ord} of ${MONTH_NAMES[m! - 1]}`;
}

/** "19:00" -> "7 PM", "19:30" -> "7:30 PM". */
export function speakTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h! >= 12 ? "PM" : "AM";
  const h12 = h! % 12 === 0 ? 12 : h! % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function isoOf(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function addDaysIso(dateIso: string, add: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const s = new Date(Date.UTC(y!, m! - 1, d!, 12) + add * 86_400_000);
  return isoOf({ year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() });
}

/** A warm, relative way to say a booking's when: "at 8 PM tonight", "tomorrow at
 * 7 PM", or "on Saturday the 3rd of October at 7 PM" for later dates. */
function speakWhen(dateIso: string, time: string, now: Date, tz: string): string {
  const tstr = speakTime(time);
  const todayIso = isoOf(localToday(now, tz));
  const h = Number(time.split(":")[0]);
  if (dateIso === todayIso) {
    if (h >= 17) return `at ${tstr} tonight`;
    if (h < 12) return `at ${tstr} this morning`;
    return `at ${tstr} this afternoon`;
  }
  if (dateIso === addDaysIso(todayIso, 1)) return `tomorrow at ${tstr}`;
  return `on ${speakDate(dateIso)} at ${tstr}`;
}

/**
 * Deterministic reservation dialogue controller (spec §15, §16). The LLM never
 * drives the booking transaction — it only helps the voice layer interpret
 * speech into the utterances fed here. Every decision, availability check and
 * write is code. Recovery is bounded (spec §4, §5, §17): no field is ever asked
 * the same way twice in a row, and after two failed attempts it changes strategy
 * (keypad, then a staff call-back) rather than looping.
 */
export class ReservationMachine {
  state: ReservationState = "GREETING";
  draft: Draft = {};
  reservation: Reservation | null = null;
  private candidates: Reservation[] = [];
  private altTimes: string[] = [];
  private nameReasks = 0;
  private phoneReasks = 0;
  private dateReasks = 0;
  private timeReasks = 0;
  private partyReasks = 0;
  /** A party size we heard but aren't sure of, awaiting a yes/no ("Four people?"). */
  private pendingParty: number | undefined;
  /** Two plausible counts from "four or five", awaiting which one. */
  private ambiguousParty: number[] | undefined;
  /** The last question we asked, for a gentle silence re-prompt (spec §11). */
  private lastPrompt = "";
  /** Warm, varied acknowledgers so the flow feels like a friendly receptionist,
   * not a clipped form (Kevin: don't sound rude/jumpy). Rotated so two in a row
   * never repeat. */
  private readonly acks = ["No worries", "Righto", "Beauty", "Too easy", "Lovely", "Not a problem"];
  private ackIdx = 0;
  private ack(): string { return this.acks[this.ackIdx++ % this.acks.length]!; }

  constructor(private ctx: ReservationContext) {}

  /** The opening line, spoken before the caller's first utterance (spec §10):
   * short, warm, reservations-framed. Recording notice folded in when required. */
  opening(opts: { recordingNotice?: boolean } = {}): string {
    const notice = opts.recordingNotice ? " This call may be recorded." : "";
    const line = `Hi, thanks for calling ${this.ctx.restaurantName}.${notice} Are you looking to book a table?`;
    this.lastPrompt = "Are you looking to book a table?";
    return line;
  }

  /** Re-ask the CURRENT question for the silence watchdog — state-aware, not a
   * generic "take your time" timer phrase (Kevin: that felt disconnected). */
  gentleReprompt(): string {
    return this.lastPrompt || "What can I help you with — a booking?";
  }

  /** Internal snapshot for turn-level debugging (spec §18). Never spoken. */
  debug(): ReservationDebug {
    return {
      state: this.state,
      draft: { ...this.draft },
      pendingParty: this.pendingParty,
      ambiguousParty: this.ambiguousParty,
      reasks: {
        date: this.dateReasks, time: this.timeReasks, party: this.partyReasks,
        name: this.nameReasks, phone: this.phoneReasks,
      },
    };
  }

  private say(say: string, kind: string, endCall = false): ReservationTurn {
    // Remember questions so the silence watchdog can gently re-ask this exact one.
    if (!endCall && /\?$/.test(say.trim())) this.lastPrompt = say.trim().split(". ").pop() ?? say.trim();
    return { say, kind, endCall };
  }

  async next(text: string): Promise<ReservationTurn> {
    // Food ordering is out of scope in every pre-confirmed state (spec §1).
    if (this.state !== "CONFIRMED" && this.state !== "END" && isFoodOrderAttempt(text)) {
      return this.say(
        "I can only help with table reservations on this line — did you want to book a table?",
        "decline_food",
      );
    }

    // Info layer: answer a factual enquiry (hours / location) from real data,
    // then carry on where we were. Uses distinctive phrasings that don't collide
    // with slot answers, so it's safe to check in any pre-confirmed state.
    if (this.state !== "CONFIRMED" && this.state !== "END") {
      const info = detectInfoQuery(text);
      if (info) return this.handleInfo(info);
    }

    // Seating / dietary / special requests, captured as NOTES from any utterance
    // (spec §21-22). Stored on the draft so a request mentioned alongside a slot
    // answer ("tomorrow at 7 for 4 by the window") rides along silently; a request
    // on its own is acknowledged and we re-ask the current question. The request
    // phrase is stripped so the slot parses cleanly from the remainder.
    const { ack: extraAck, cleaned } = this.state !== "END"
      ? this.captureExtras(text)
      : { ack: "", cleaned: text };
    if (extraAck && this.state === "POST_CONFIRM") {
      await this.persistExtrasToReservation();
      return this.say(`${extraAck}. Anything else, or are you all set?`, "note_added");
    }

    const before = this.state;
    const turn = await this.route(cleaned || text);
    // Pure-preference interjection (the handler didn't move on) → fold the ack in.
    if (extraAck && this.state === before && /^ask_/.test(turn.kind)) {
      return { ...turn, say: `${extraAck}. ${turn.say}` };
    }
    return turn;
  }

  private route(text: string): Promise<ReservationTurn> {
    switch (this.state) {
      case "GREETING": return this.handleGreeting(text);
      case "COLLECT_DATE": return this.handleDate(text);
      case "COLLECT_TIME": return this.handleTime(text);
      case "COLLECT_PARTY_SIZE": return this.handleParty(text);
      case "CONFIRM_PARTY": return this.handleConfirmParty(text);
      case "OFFER_ALTERNATIVES": return this.handleAlternatives(text);
      case "COLLECT_NAME": return this.handleName(text);
      case "COLLECT_PHONE": return this.handlePhone(text);
      case "POST_CONFIRM": return this.handlePostConfirm(text);
      case "FIND_BOOKING": return this.handleFindBooking(text);
      case "CANCEL_CONFIRM": return this.handleCancelConfirm(text);
      case "MODIFY_WHAT": return this.handleModifyWhat(text);
      case "ESCALATION": return this.handleEscalation(text);
      default: return Promise.resolve(this.say("Did you want to book, change or cancel a table?", "reprompt"));
    }
  }

  /** Capture a seating / dietary / special request into the draft as a note, and
   * strip the request phrase from the text so the slot parses from the remainder.
   * Returns { ack (guarantee-free, "" if nothing new), cleaned text }. */
  private captureExtras(text: string): { ack: string; cleaned: string } {
    const acks: string[] = [];
    let cleaned = text;
    const seat = detectSeating(text);
    if (seat && !(this.draft.specialRequests ?? "").includes(seat)) {
      this.draft.specialRequests = [this.draft.specialRequests, seat].filter(Boolean).join("; ");
      if (seat.startsWith("outdoor")) this.draft.seatingPref = "outdoor";
      else if (seat.startsWith("indoor")) this.draft.seatingPref = "indoor";
      acks.push(`No worries, I'll note a request for a ${seat}`);
      cleaned = cleaned
        .replace(/\b(?:by|near|next to|beside)?\s*(?:the\s+)?window(?:\s+seat|\s+table)?\b/gi, " ")
        .replace(/\b(?:outside|outdoors?|out door|alfresco|courtyard|patio|garden)\b/gi, " ")
        .replace(/\b(?:indoors?|inside)\b/gi, " ")
        .replace(/\bbooth\b/gi, " ");
    }
    const special = detectSpecialRequest(text);
    if (special && !(this.draft.specialRequests ?? "").includes(special)) {
      this.draft.specialRequests = [this.draft.specialRequests, special].filter(Boolean).join("; ");
      acks.push(`I've made a note — ${special}`);
      cleaned = cleaned
        .replace(/\b(?:i'?m|we'?re|i am)?\s*allerg(?:ic|y)(?:\s+to)?\s+[a-z\s]*?(?=[.,]|$|\bplease\b|\band\b|\bthanks?\b)/gi, " ")
        .replace(/\b(vegan|vegetarian|veggie|gluten[\s-]?free|coeliac|celiac|halal|kosher|high\s?chair|highchair|wheelchair|accessible|accessibility|mobility|birthday|anniversary|engagement|celebration|celebrating)\b/gi, " ");
    }
    cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
    return { ack: acks.join(". "), cleaned };
  }

  /** Persist newly-captured notes onto an already-created booking (POST_CONFIRM). */
  private async persistExtrasToReservation(): Promise<void> {
    if (!this.reservation) return;
    try {
      await this.ctx.db.query(
        `UPDATE reservations SET special_requests = $2, seating_pref = $3, updated_at = now() WHERE id = $1`,
        [this.reservation.id, this.draft.specialRequests ?? "", this.draft.seatingPref ?? ""],
      );
    } catch {
      /* best-effort note update — never breaks the confirmed booking */
    }
  }

  // ------------------------------------------------------------ info layer

  /** Answer a factual enquiry, then steer back to where we were. Never invents:
   * everything comes from the restaurant's own hours / address. */
  private handleInfo(kind: "hours" | "location"): ReservationTurn {
    const body = kind === "hours" ? this.describeHours() : this.describeLocation();
    const tail = this.state === "GREETING" || !this.lastPrompt
      ? " Would you like to book a table?"
      : ` ${this.lastPrompt}`;
    return this.say(`${body}${tail}`, `info_${kind}`);
  }

  private describeHours(): string {
    const rows = this.ctx.hours ?? [];
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const order = [1, 2, 3, 4, 5, 6, 0]; // Mon → Sun, natural reading order
    const keyOf = (dow: number): string => {
      const r = rows.find((x) => x.dayOfWeek === dow);
      if (!r || r.isClosed || !r.opensAt || !r.closesAt) return "closed";
      return `${r.opensAt.slice(0, 5)}|${r.closesAt.slice(0, 5)}`;
    };
    // Open around the clock every day — say it the natural way.
    const is24 = (k: string): boolean => k === "00:00|23:59" || k === "00:00|00:00";
    if (order.every((d) => is24(keyOf(d)))) return "We're open 24 hours a day, seven days a week.";
    const groups: { key: string; days: number[] }[] = [];
    for (const d of order) {
      const k = keyOf(d);
      const last = groups[groups.length - 1];
      if (last && last.key === k) last.days.push(d);
      else groups.push({ key: k, days: [d] });
    }
    if (groups.every((g) => g.key === "closed")) {
      return "I'm not sure of the exact hours right now — I can have the team confirm.";
    }
    const span = (days: number[]): string =>
      days.length === 1 ? dayNames[days[0]!]! : `${dayNames[days[0]!]!} to ${dayNames[days[days.length - 1]!]!}`;
    const openParts: string[] = [];
    const closedParts: string[] = [];
    for (const g of groups) {
      if (g.key === "closed") { closedParts.push(span(g.days)); continue; }
      const [o, c] = g.key.split("|") as [string, string];
      const label = o === "00:00" && (c === "23:59" || c === "00:00")
        ? "24 hours"
        : `${speakTime(o)} to ${speakTime(c)}`;
      openParts.push(`${span(g.days)} ${label}`);
    }
    let s = `We're open ${openParts.join("; ")}.`;
    if (closedParts.length) s += ` We're closed ${closedParts.join(" and ")}.`;
    return s;
  }

  private describeLocation(): string {
    const a = (this.ctx.address ?? "").trim();
    if (a) return `We're at ${a}.`;
    const p = (this.ctx.phoneDisplay ?? "").trim();
    return p
      ? `I don't have the address to hand, but you can reach the restaurant on ${p}.`
      : "I can have the team text you the address.";
  }

  // ------------------------------------------------------------ booking flow

  private async handleGreeting(text: string): Promise<ReservationTurn> {
    const intent = detectIntent(text);
    if (intent === "cancel" || intent === "modify" || intent === "confirm") {
      this.pendingAction = intent;
      return this.beginFindBooking();
    }
    if (intent === "info") {
      return this.say("Happy to help — what day were you after?", "info");
    }
    // Pull anything already offered in the opener so we don't re-ask it (spec §14).
    const gotDate = this.applyDateFrom(text);
    const gotParty = this.applyPartyFrom(text);
    const gotTime = this.applyTimeFrom(text);
    if (!gotDate && !gotParty && !gotTime && isNo(text)) {
      return this.say(
        "No worries. I can book you a table, or change one you've already got — what would you like?",
        "greeting_help",
      );
    }
    return this.advanceBooking();
  }

  private pendingAction: "cancel" | "modify" | "confirm" = "confirm";

  private applyDateFrom(text: string): boolean {
    const r = normaliseDate(text, {
      now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays,
    });
    if (r.date) { this.draft.date = r.date; return true; }
    return false;
  }
  private applyPartyFrom(text: string): boolean {
    const n = parsePartySize(text);
    if (n) { this.draft.partySize = n; return true; }
    return false;
  }

  /** Party size ONLY from an explicit phrase ("four people", "party of six",
   * "table for four", "two of us") — never a bare number, which at the date/time
   * step means a day or an hour, not a head count. Safe to call mid-flow. */
  private applyExplicitPartyFrom(text: string): boolean {
    if (this.draft.partySize !== undefined) return false;
    const explicit =
      /\b(?:party|group|table|booking)\s+(?:of|for)\s+\w+/i.test(text) ||
      /\b\w+\s+(?:people|persons|person|guests|guest|pax|adults|of\s+us|heads|covers)\b/i.test(text);
    if (!explicit) return false;
    const n = parsePartySize(text);
    if (n) { this.draft.partySize = n; return true; }
    return false;
  }

  /** Remove the captured party's words ("for four", "four people", "party of
   * four") so its number can't be mistaken for an hour when parsing a time. */
  private blankParty(text: string): string {
    const s = ` ${text.toLowerCase()} `;
    if (this.draft.partySize === undefined) return s;
    const n = this.draft.partySize;
    const w = numberWord(n);
    return s
      .replace(new RegExp(`\\bfor (?:${n}|${w})\\b`, "g"), " ")
      .replace(new RegExp(`\\b(?:${n}|${w}) (?:people|persons|guests|pax|adults|of us|heads)\\b`, "g"), " ")
      .replace(new RegExp(`\\b(?:party|group|table|booking) (?:of|for) (?:${n}|${w})\\b`, "g"), " ");
  }

  /** Extract a time from a free-form utterance ONLY when there's an explicit time
   * cue, and after blanking out a party number so "for four" isn't read as 4 AM
   * (spec §14). Bare utterances with no time still fall through to the time question. */
  private applyTimeFrom(text: string): boolean {
    const t = this.blankParty(text);
    const hasCue =
      /\b\d{1,2}\s*(?:am|pm)\b/.test(t) ||
      /\b\d{1,2}[:.h]\d{2}\b/.test(t) ||
      /\bo'?clock\b/.test(t) ||
      /\b(?:at|around|about|by|for)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midday|midnight|half|quarter)\b/.test(t);
    if (!hasCue) return false;
    const r = normaliseTime(t);
    if (r.time) { this.draft.time = r.time; return true; }
    return false;
  }

  /** Ask for the next missing booking slot, or run availability once all present. */
  private async advanceBooking(): Promise<ReservationTurn> {
    if (!this.draft.date) { this.state = "COLLECT_DATE"; return this.say("Sure thing — what day were you thinking?", "ask_date"); }
    if (!this.draft.time) { this.state = "COLLECT_TIME"; return this.say(`${this.ack()}. And what time suits you?`, "ask_time"); }
    if (this.draft.partySize === undefined) { this.state = "COLLECT_PARTY_SIZE"; return this.say(`${this.ack()}. And how many will be joining you?`, "ask_party"); }
    return this.runAvailability();
  }

  private handleDate(text: string): Promise<ReservationTurn> {
    const r = normaliseDate(text, {
      now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays,
    });
    if (r.date) {
      this.dateReasks = 0;
      this.draft.date = r.date;
      // Capture an explicit party + a time given in the same breath ("tomorrow at
      // 5 for four people") so we don't re-ask what the caller already said. Party
      // first, so applyTimeFrom can blank the party words before reading the hour.
      this.applyExplicitPartyFrom(text);
      if (this.draft.time === undefined) this.applyTimeFrom(text);
      return this.advanceBooking();
    }
    this.dateReasks++;
    if (this.dateReasks >= 3) return this.beginEscalation();
    if (r.error === "PAST") return Promise.resolve(this.say("That day's already passed — what day would you like?", "ask_date"));
    if (r.error === "TOO_FAR") return Promise.resolve(this.say("That's a bit too far ahead — what day would you like?", "ask_date"));
    return Promise.resolve(this.say(
      this.dateReasks === 1 ? "What day would you like the table?" : "Which day suits — today, tomorrow, or later in the week?",
      "ask_date",
    ));
  }

  private handleTime(text: string): Promise<ReservationTurn> {
    // Capture an explicit party said alongside the time ("seven, for four people"
    // / "four people at seven") so we never re-ask what was already given.
    this.applyExplicitPartyFrom(text);
    // "seven, actually make it two" — a mid-answer party correction: take the
    // time from BEFORE the correction word and the party from AFTER it. Only
    // splits when the correction is genuinely mid-utterance (index > 0), so a
    // leading "no, seven" stays a pure time answer.
    const corr = text.match(/\b(actually|make it|change (?:it |that )?to|i mean|rather|no)\b/i);
    const split = corr && corr.index !== undefined && corr.index > 0;
    const base = split ? text.slice(0, corr!.index) : text;
    if (split) {
      const p = parsePartySize(text.slice(corr!.index!));
      if (p) this.draft.partySize = p;
    }
    // Blank any captured party words so its number isn't mis-read as the hour.
    const timeText = this.blankParty(base).trim();
    const r = normaliseTime(timeText || text);
    if (r.time) { this.timeReasks = 0; this.draft.time = r.time; return this.advanceBooking(); }
    this.timeReasks++;
    if (this.timeReasks >= 3) return this.beginEscalation();
    return Promise.resolve(this.say(
      this.timeReasks === 1 ? "What time were you after?" : "What time — say, six, seven or eight?",
      "ask_time",
    ));
  }

  /**
   * Party size — the highest-risk slot (spec §2-§8, §23). Confident answers pass
   * straight through; an uncertain best guess (STT "for" for "four", a lone
   * number in filler) is CONFIRMED not rejected; "four or five" is disambiguated;
   * and an unparseable answer escalates recovery (reword → keypad → staff
   * call-back) instead of looping the same question.
   */
  private handleParty(text: string): Promise<ReservationTurn> {
    // Resolve a pending "four or five?" by picking the earlier/later option.
    if (this.ambiguousParty) {
      const [a, b] = this.ambiguousParty;
      const pick =
        /\b(first|former|smaller|lower|fewer|less)\b/i.test(text) ? a :
        /\b(second|latter|bigger|higher|more|larger)\b/i.test(text) ? b :
        null;
      if (pick) { this.ambiguousParty = undefined; return this.acceptParty(pick); }
    }

    const r = interpretPartySize(text, { expectingParty: true });
    if (r.kind === "value") return this.acceptParty(r.value);
    if (r.kind === "ambiguous") {
      this.ambiguousParty = r.options;
      return Promise.resolve(this.say(
        `Should I book for ${numberWord(r.options[0]!)} or ${numberWord(r.options[1]!)}?`,
        "ask_party",
      ));
    }
    if (r.kind === "candidate") {
      this.pendingParty = r.value;
      this.state = "CONFIRM_PARTY";
      return Promise.resolve(this.say(`${cap(numberWord(r.value))} people?`, "confirm_party"));
    }
    // Nothing number-like. Escalate the recovery strategy (spec §5): one reword,
    // then keypad, then a staff call-back. Never the same question, never "Sorry".
    this.partyReasks++;
    if (this.partyReasks >= 3) return this.beginEscalation();
    return Promise.resolve(this.say(
      this.partyReasks === 1
        ? "How many people, all up?"
        : "I didn't catch the number — you can say it, or tap it in on your keypad.",
      this.partyReasks === 1 ? "ask_party" : "ask_party_dtmf",
    ));
  }

  private acceptParty(n: number): Promise<ReservationTurn> {
    this.partyReasks = 0;
    this.pendingParty = undefined;
    this.ambiguousParty = undefined;
    this.draft.partySize = n;
    return this.advanceBooking();
  }

  /** "Four people?" — resolve the pending candidate (spec §8). A fresh number
   * overrides it; yes accepts; no re-asks; anything else re-confirms once. */
  private handleConfirmParty(text: string): Promise<ReservationTurn> {
    const r = interpretPartySize(text, { expectingParty: true });
    if (r.kind === "value") return this.acceptParty(r.value);
    if (r.kind === "ambiguous") {
      this.ambiguousParty = r.options;
      this.state = "COLLECT_PARTY_SIZE";
      return Promise.resolve(this.say(
        `Should I book for ${numberWord(r.options[0]!)} or ${numberWord(r.options[1]!)}?`,
        "ask_party",
      ));
    }
    if (isYes(text) && this.pendingParty !== undefined) return this.acceptParty(this.pendingParty);
    if (isNo(text)) {
      this.pendingParty = undefined;
      this.state = "COLLECT_PARTY_SIZE";
      return Promise.resolve(this.say("No worries — how many people?", "ask_party"));
    }
    if (r.kind === "candidate") {
      this.pendingParty = r.value;
      return Promise.resolve(this.say(`${cap(numberWord(r.value))} people?`, "confirm_party"));
    }
    this.partyReasks++;
    if (this.partyReasks >= 3) return this.beginEscalation();
    return Promise.resolve(this.say(
      `Just to check — ${numberWord(this.pendingParty ?? 0)} people? You can say yes, or the number.`,
      "confirm_party",
    ));
  }

  /** Graceful escalation (spec §5, §28, §31): stop looping, take a name + mobile
   * for a staff call-back. Never a confirmed booking. */
  private beginEscalation(): Promise<ReservationTurn> {
    this.state = "ESCALATION";
    this.nameReasks = 0;
    this.phoneReasks = 0;
    if (!this.draft.name) {
      return Promise.resolve(this.say("No worries — I'll get the team to sort it. What name should I put it under?", "escalate_name"));
    }
    if (!this.draft.phone && !this.ctx.callerPhone) {
      return Promise.resolve(this.say("And the best mobile number?", "escalate_phone"));
    }
    return this.completeEscalation();
  }

  private async handleEscalation(text: string): Promise<ReservationTurn> {
    if (!this.draft.name) {
      const name = parseName(text);
      if (name) this.draft.name = name;
      else if (++this.nameReasks >= 2) this.draft.name = "Guest";
      else return this.say("Sorry, what name should I put it under?", "escalate_name");
    }
    if (this.draft.name && !this.draft.phone && !this.ctx.callerPhone) {
      const phone = parsePhone(text);
      if (phone) this.draft.phone = phone;
      else if (++this.phoneReasks < 2) return this.say("What's the best mobile number, digit by digit?", "escalate_phone");
    }
    return this.completeEscalation();
  }

  private async completeEscalation(): Promise<ReservationTurn> {
    this.state = "END";
    const phone = this.draft.phone ?? this.ctx.callerPhone ?? "unknown";
    // A call-back request, NOT a confirmed booking (spec §31). Owner alerted to follow up.
    if (this.ctx.ownerAlertNumber) {
      try {
        await enqueueNotification(this.ctx.db, {
          orderId: null,
          kind: "owner_sms",
          toNumber: this.ctx.ownerAlertNumber,
          body: `${this.ctx.restaurantName}: table-booking request to confirm — ${this.draft.name ?? "caller"}, ${this.draft.partySize ?? "?"} people, ${this.draft.date ?? "?"} ${this.draft.time ?? ""}, ph ${phone}. Please call back.`,
        });
      } catch {
        /* owner alert is best-effort */
      }
    }
    return this.say(
      "No worries — I've taken your details and the team will confirm the table and call you back shortly. Thanks for calling.",
      "escalated",
      true,
    );
  }

  private async runAvailability(): Promise<ReservationTurn> {
    const { date, time, partySize } = this.draft;
    const result = await checkAvailability({
      db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
      settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
      date: date!, time: time!, partySize: partySize!,
    });
    switch (result.status) {
      case "AVAILABLE":
        return this.collectContact();
      case "PARTY_TOO_LARGE":
        this.state = "ESCALATION";
        return this.say(
          `For a group of ${partySize}, I'll need the restaurant team to confirm it. Can I take a name and mobile so they can call you back?`,
          "escalate_party",
        );
      case "CLOSED":
        this.state = "COLLECT_TIME";
        this.draft.time = undefined;
        return this.say(`We're not open then. What time would you like, or a different day?`, "ask_time");
      case "INVALID_DATE":
        this.state = "COLLECT_TIME";
        this.draft.time = undefined;
        return this.say("That time won't work — what time would you like?", "ask_time");
      case "ALTERNATIVES_AVAILABLE": {
        this.altTimes = result.alternatives;
        this.state = "OFFER_ALTERNATIVES";
        const opts = result.alternatives.slice(0, 2).map(speakTime);
        const list = opts.length === 2 ? `${opts[0]} or ${opts[1]}` : opts[0];
        return this.say(`${speakTime(time!)}'s booked out, but I've got ${list}. Would either of those work?`, "alternatives");
      }
      case "UNAVAILABLE":
      default:
        this.state = "COLLECT_TIME";
        this.draft.time = undefined;
        return this.say(`Sorry, we're fully booked around then. Is there another time that'd suit?`, "unavailable");
    }
  }

  private handleAlternatives(text: string): Promise<ReservationTurn> {
    // Did they name/accept one of the offered times?
    const t = normaliseTime(text);
    const picked =
      (t.time && this.altTimes.includes(t.time) && t.time) ||
      (isYes(text) && this.altTimes[0]) ||
      (/\b(first|earlier|second|later)\b/i.test(text) &&
        (/\b(second|later)\b/i.test(text) ? this.altTimes[1] : this.altTimes[0])) ||
      null;
    if (picked) {
      this.draft.time = picked;
      return this.runAvailability();
    }
    if (isNo(text)) {
      this.state = "COLLECT_TIME";
      this.draft.time = undefined;
      return Promise.resolve(this.say("No worries — what time would you prefer?", "ask_time"));
    }
    return Promise.resolve(this.say(`Would you like ${this.altTimes.slice(0, 2).map(speakTime).join(" or ")}?`, "alternatives"));
  }

  private collectContact(): Promise<ReservationTurn> {
    if (!this.draft.name) { this.state = "COLLECT_NAME"; return Promise.resolve(this.say(`${this.ack()}, that time's free. Can I grab a name for the booking?`, "ask_name")); }
    if (!this.draft.phone && !this.ctx.callerPhone) { this.state = "COLLECT_PHONE"; return Promise.resolve(this.say("Lovely. And the best mobile to reach you on?", "ask_phone")); }
    return this.finaliseBooking();
  }

  private handleName(text: string): Promise<ReservationTurn> {
    const name = parseName(text);
    if (!name) {
      this.nameReasks++;
      if (this.nameReasks >= 3) { this.state = "COLLECT_NAME"; return Promise.resolve(this.say("Let's try again — what name should I put the table under?", "ask_name")); }
      return Promise.resolve(this.say(this.nameReasks === 1 ? "I didn't catch the name — just a first name's fine." : "And what name's the booking under?", "ask_name"));
    }
    this.draft.name = name;
    return this.collectContact();
  }

  private handlePhone(text: string): Promise<ReservationTurn> {
    const phone = parsePhone(text);
    if (!phone) {
      this.phoneReasks++;
      if (this.phoneReasks >= 3) return this.beginEscalation();
      return Promise.resolve(this.say(
        this.phoneReasks === 1
          ? "Sorry, could I get the mobile number again?"
          : "You can say the mobile digit by digit, or tap it in on your keypad.",
        this.phoneReasks === 1 ? "ask_phone" : "ask_phone_dtmf",
      ));
    }
    this.draft.phone = phone;
    return this.finaliseBooking();
  }

  private async finaliseBooking(): Promise<ReservationTurn> {
    const phone = this.draft.phone ?? this.ctx.callerPhone!;
    const { date, time, partySize, name } = this.draft;
    // Idempotency key so a retried/duplicated finalise can't double-book (§8).
    const idempotencyKey = `${this.ctx.callId ?? phone}:${date}:${time}:${partySize}`;
    const input = {
      restaurantId: this.ctx.restaurantId, customerName: name!, customerPhone: phone,
      date: date!, time: time!, partySize: partySize!, source: "phone",
      callId: this.ctx.callId ?? null, idempotencyKey,
      specialRequests: this.draft.specialRequests ?? "",
      seatingPref: this.draft.seatingPref ?? "",
    };

    let created;
    try {
      created = await createReservation(this.ctx.db, input);
    } catch (err) {
      if (err instanceof ReservationCapacityError) {
        // §7: the slot filled between check and create — offer alternatives, never confirm.
        const avail = await checkAvailability({
          db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
          settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
          date: date!, time: time!, partySize: partySize!,
        });
        if (avail.status === "ALTERNATIVES_AVAILABLE" && avail.alternatives.length) {
          this.altTimes = avail.alternatives;
          this.state = "OFFER_ALTERNATIVES";
          return this.say(
            `Sorry, that spot's just gone — but I've got ${avail.alternatives.slice(0, 2).map(speakTime).join(" or ")}. Would either work?`,
            "capacity_gone",
          );
        }
        this.draft.time = undefined;
        this.state = "COLLECT_TIME";
        return this.say("Sorry, that spot's just gone. What other time would suit?", "capacity_gone");
      }
      // §30: one safe automatic retry (same idempotency key so it can't double-book).
      try {
        created = await createReservation(this.ctx.db, input);
      } catch {
        // §31: fail-safe — never pretend a booking exists.
        this.state = "END";
        return this.say(
          "Sorry, I'm having trouble confirming that right now. I'll take your details and the team will follow it up.",
          "booking_failed",
          true,
        );
      }
    }

    // §44: confirm from the record the DB returned, not conversation variables.
    const r = created.reservation;
    this.reservation = r;
    // Keep the line open so the caller can change or cancel in THIS call, rather
    // than having to ring back if they change their mind.
    this.state = "POST_CONFIRM";
    void this.sendConfirmationSms(r); // §43, best-effort, never blocks the reply
    const when = speakWhen(r.reservationDate, r.reservationTime.slice(0, 5), this.ctx.now(), this.ctx.timezone);
    const noted = (r.specialRequests ?? "").trim() ? " I've popped your notes on the booking for the team." : "";
    return this.say(
      `Beauty — that's you booked for ${r.partySize} ${when}, under ${r.customerName}.${noted} I'll flick you a text to confirm. Anything else, or are you all set?`,
      "confirmed",
      false,
    );
  }

  /** After a booking is confirmed we stay on the line: the caller can change or
   * cancel it in the same call, or ring off. "No / that's all / thanks" keeps the
   * booking and ends warmly; only an explicit cancel removes it. */
  private async handlePostConfirm(text: string): Promise<ReservationTurn> {
    const intent = detectIntent(text);
    if (intent === "cancel" && this.reservation) {
      const cancelled = await cancelReservation(this.ctx.db, this.reservation.id);
      this.reservation = null; // net effect: no active booking
      this.state = "END";
      return this.say(
        cancelled
          ? "No worries, I've cancelled that booking. Thanks for calling."
          : "That booking's already cancelled. Thanks for calling.",
        "cancelled_same_call",
        true,
      );
    }
    if (intent === "modify" && this.reservation) {
      this.candidates = [this.reservation];
      this.pendingAction = "modify";
      this.state = "MODIFY_WHAT";
      return this.say("Sure — what would you like to change?", "modify_what");
    }
    // "no / that's all / all good / thanks / bye" (or anything unclear): the
    // booking stands and we ring off warmly.
    this.state = "END";
    return this.say("Beauty — you're all set. Thanks for calling, see you then!", "goodbye", true);
  }

  /** SMS confirmation generated from the stored reservation row (§43-44). */
  private async sendConfirmationSms(r: Reservation): Promise<void> {
    if (!this.ctx.customerSmsEnabled || !r.customerPhone.startsWith("+")) return;
    try {
      await enqueueNotification(this.ctx.db, {
        orderId: null,
        kind: "customer_sms",
        toNumber: r.customerPhone,
        body: `${this.ctx.restaurantName}: booking confirmed for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}, under ${r.customerName}. Ref ${r.publicRef}.`,
      });
    } catch {
      /* SMS is best-effort — a failed enqueue must never affect the confirmed booking */
    }
  }

  // ------------------------------------------------------------ find / cancel / modify

  private beginFindBooking(): Promise<ReservationTurn> {
    this.state = "FIND_BOOKING";
    return this.loadCallerBookings();
  }

  private async loadCallerBookings(): Promise<ReservationTurn> {
    if (!this.ctx.callerPhone) {
      this.state = "END";
      return this.say("I can look that up if you call from the number on the booking. Please call back from that mobile.", "no_caller_id", true);
    }
    this.candidates = await findReservations(this.ctx.db, this.ctx.restaurantId, this.ctx.callerPhone);
    if (this.candidates.length === 0) {
      this.state = "END";
      return this.say("I can't find a booking under this number. Would you like to make one?", "not_found");
    }
    const r = this.candidates[0]!;
    const summary = `for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}`;
    if (this.pendingAction === "confirm") {
      this.state = "END";
      return this.say(`Yes, you're booked ${summary}. See you then.`, "confirm_existing", true);
    }
    if (this.pendingAction === "cancel") {
      this.state = "CANCEL_CONFIRM";
      return this.say(`I've found your booking ${summary}. Would you like me to cancel it?`, "cancel_confirm");
    }
    this.state = "MODIFY_WHAT";
    return this.say(`I've found your booking ${summary}. What would you like to change?`, "modify_what");
  }

  private handleFindBooking(_text: string): Promise<ReservationTurn> {
    return this.loadCallerBookings();
  }

  private async handleCancelConfirm(text: string): Promise<ReservationTurn> {
    if (isYes(text)) {
      const cancelled = await cancelReservation(this.ctx.db, this.candidates[0]!.id);
      this.state = "END";
      return this.say(cancelled ? "Done, that's cancelled. You'll get a text to confirm." : "That booking's already cancelled.", "cancelled", true);
    }
    if (isNo(text)) {
      this.state = "END";
      return this.say("No worries, I'll leave it as is.", "keep", true);
    }
    return this.say("Would you like me to cancel that booking?", "cancel_confirm");
  }

  private async handleModifyWhat(text: string): Promise<ReservationTurn> {
    const changes: { date?: string; time?: string; partySize?: number } = {};
    const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
    if (d.date) changes.date = d.date;
    const tm = normaliseTime(text);
    if (tm.time && /\b(time|at|pm|am|o'?clock|:|thirty|half|quarter|move|make it)\b/i.test(text)) changes.time = tm.time;
    const party = parsePartySize(text);
    if (party && /\b(people|guests|party|make it|of us|to)\b/i.test(text)) changes.partySize = party;

    if (!changes.date && !changes.time && changes.partySize === undefined) {
      return this.say("Sure — a new day, a new time, or a different number of people?", "modify_what");
    }
    const result = await modifyReservation(this.ctx.db, {
      reservationId: this.candidates[0]!.id, changes,
      hours: this.ctx.hours, settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
    });
    if ("reservation" in result) {
      const r = result.reservation;
      this.reservation = r;
      this.state = "CONFIRMED";
      return this.say(
        `Done. Your booking's now for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}. I'll text the update.`,
        "modified", true,
      );
    }
    if ("unavailable" in result) {
      const alts = result.unavailable.alternatives.slice(0, 2).map(speakTime);
      if (alts.length) return this.say(`That's not available, but I've got ${alts.join(" or ")}. Would either work?`, "modify_unavailable");
      return this.say("That's not available I'm afraid. Another time?", "modify_unavailable");
    }
    this.state = "END";
    return this.say("I couldn't find that booking anymore. Anything else?", "modify_notfound");
  }
}
