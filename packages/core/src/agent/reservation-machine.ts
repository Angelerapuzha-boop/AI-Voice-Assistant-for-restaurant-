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
import { normaliseDate, normaliseTime } from "../domain/reservation-time";
import {
  detectIntent,
  isFoodOrderAttempt,
  isNo,
  isYes,
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
}

export type ReservationState =
  | "GREETING"
  | "COLLECT_DATE"
  | "COLLECT_TIME"
  | "COLLECT_PARTY_SIZE"
  | "OFFER_ALTERNATIVES"
  | "COLLECT_NAME"
  | "COLLECT_PHONE"
  | "CONFIRM_DETAILS"
  | "CONFIRMED"
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
}

export interface ReservationTurn {
  say: string;
  kind: string;
  endCall?: boolean;
}

// ---------------------------------------------------------------- speech helpers

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
];

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

/**
 * Deterministic reservation dialogue controller (spec §15). The LLM never drives
 * the booking transaction — it only helps the voice layer interpret speech into
 * the utterances fed here. Every decision, availability check and write is code.
 */
export class ReservationMachine {
  state: ReservationState = "GREETING";
  draft: Draft = {};
  reservation: Reservation | null = null;
  private candidates: Reservation[] = [];
  private altTimes: string[] = [];
  private nameReasks = 0;
  private phoneReasks = 0;

  constructor(private ctx: ReservationContext) {}

  /** The opening line, spoken before the caller's first utterance. */
  opening(): string {
    return `Thanks for calling ${this.ctx.restaurantName}. I can help you book a table. What day were you after?`;
  }

  private say(say: string, kind: string, endCall = false): ReservationTurn {
    return { say, kind, endCall };
  }

  async next(text: string): Promise<ReservationTurn> {
    // Food ordering is out of scope in every pre-confirmed state (spec §1).
    if (this.state !== "CONFIRMED" && this.state !== "END" && isFoodOrderAttempt(text)) {
      return this.say(
        "Sorry, I can only help with table reservations over the phone. You're welcome to place a food order directly with the restaurant. Did you want to book a table?",
        "decline_food",
      );
    }

    switch (this.state) {
      case "GREETING": return this.handleGreeting(text);
      case "COLLECT_DATE": return this.handleDate(text);
      case "COLLECT_TIME": return this.handleTime(text);
      case "COLLECT_PARTY_SIZE": return this.handleParty(text);
      case "OFFER_ALTERNATIVES": return this.handleAlternatives(text);
      case "COLLECT_NAME": return this.handleName(text);
      case "COLLECT_PHONE": return this.handlePhone(text);
      case "FIND_BOOKING": return this.handleFindBooking(text);
      case "CANCEL_CONFIRM": return this.handleCancelConfirm(text);
      case "MODIFY_WHAT": return this.handleModifyWhat(text);
      default: return this.say("Did you want to book, change or cancel a table?", "reprompt");
    }
  }

  // ------------------------------------------------------------ booking flow

  private async handleGreeting(text: string): Promise<ReservationTurn> {
    const intent = detectIntent(text);
    if (intent === "cancel" || intent === "modify" || intent === "confirm") {
      this.pendingAction = intent;
      return this.beginFindBooking();
    }
    if (intent === "info") {
      return this.say("Happy to help with that when you're ready to book — what day were you after?", "info");
    }
    // Default to booking. Pull any date / party already offered in the opener.
    this.applyDateFrom(text);
    this.applyPartyFrom(text);
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

  /** Ask for the next missing booking slot, or run availability once all present. */
  private async advanceBooking(): Promise<ReservationTurn> {
    if (!this.draft.date) { this.state = "COLLECT_DATE"; return this.say("Sure. What day were you after?", "ask_date"); }
    if (!this.draft.time) { this.state = "COLLECT_TIME"; return this.say("And what time?", "ask_time"); }
    if (this.draft.partySize === undefined) { this.state = "COLLECT_PARTY_SIZE"; return this.say("How many people?", "ask_party"); }
    return this.runAvailability();
  }

  private handleDate(text: string): Promise<ReservationTurn> {
    const r = normaliseDate(text, {
      now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays,
    });
    if (r.error === "PAST") return Promise.resolve(this.say("That day's already passed — what day would you like?", "ask_date"));
    if (r.error === "TOO_FAR") return Promise.resolve(this.say("That's a bit too far ahead to book — what day would you like?", "ask_date"));
    if (!r.date) return Promise.resolve(this.say("Sorry, what day would you like the table?", "ask_date"));
    this.draft.date = r.date;
    return this.advanceBooking();
  }

  private handleTime(text: string): Promise<ReservationTurn> {
    // Allow a correction that also changes the party ("actually make it five").
    this.applyPartyCorrection(text);
    const r = normaliseTime(text);
    if (!r.time) return Promise.resolve(this.say("Sorry, what time were you after?", "ask_time"));
    this.draft.time = r.time;
    return this.advanceBooking();
  }

  private handleParty(text: string): Promise<ReservationTurn> {
    const n = parsePartySize(text);
    if (!n) return Promise.resolve(this.say("Sorry, how many people?", "ask_party"));
    this.draft.partySize = n;
    return this.advanceBooking();
  }

  /** Mid-flow "actually make it five" corrections to party size. */
  private applyPartyCorrection(text: string): void {
    if (/\b(actually|make it|change to|no|sorry)\b/i.test(text)) {
      const n = parsePartySize(text);
      if (n) this.draft.partySize = n;
    }
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
    if (!this.draft.name) { this.state = "COLLECT_NAME"; return Promise.resolve(this.say("Great, that's available. What name should I put it under?", "ask_name")); }
    if (!this.draft.phone && !this.ctx.callerPhone) { this.state = "COLLECT_PHONE"; return Promise.resolve(this.say("And the best mobile number?", "ask_phone")); }
    return this.finaliseBooking();
  }

  private handleName(text: string): Promise<ReservationTurn> {
    const name = parseName(text);
    if (!name) {
      this.nameReasks++;
      if (this.nameReasks >= 3) { this.state = "COLLECT_NAME"; return Promise.resolve(this.say("Let's try again — what name should I put the table under?", "ask_name")); }
      return Promise.resolve(this.say(this.nameReasks === 1 ? "Sorry, what name should I put it under?" : "What name for the table?", "ask_name"));
    }
    this.draft.name = name;
    return this.collectContact();
  }

  private handlePhone(text: string): Promise<ReservationTurn> {
    const phone = parsePhone(text);
    if (!phone) {
      this.phoneReasks++;
      return Promise.resolve(this.say(this.phoneReasks === 1 ? "Sorry, could I get the mobile number again?" : "What's the best mobile number, digit by digit?", "ask_phone"));
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
    this.state = "CONFIRMED";
    void this.sendConfirmationSms(r); // §43, best-effort, never blocks the reply
    return this.say(
      `Done. You're booked for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}, under ${r.customerName}. I'll text you a confirmation.`,
      "confirmed",
      true,
    );
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
