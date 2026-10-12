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
import { localToday, normaliseDate, normaliseTime, shiftDate } from "../domain/reservation-time";
import {
  detectBotQuestion,
  detectBusy,
  detectDispleasure,
  detectDone,
  detectHumanRequest,
  detectInfoQuery,
  detectIntent,
  detectUnsupportedTopic,
  detectRepeatRequest,
  detectSeating,
  detectVagueDate,
  detectVagueTime,
  detectChangeRequest,
  detectSpecialRequest,
  detectWeekShift,
  interpretPartySize,
  isFoodOrderAttempt,
  isNo,
  isYes,
  numberWord,
  parseName,
  parsePartySize,
  parsePhone,
  parseSpelledName,
} from "./reservation-parse";

/** Recognised common first names — a name in this set is trusted and booked
 * straight away; a name NOT in it (or ≤2 letters) is read back for confirmation
 * with an offer to spell, so a mis-heard name is caught before booking. Broad on
 * purpose (AU + common international names) so genuine names rarely need the extra
 * beat; STT garble ("Got", "Silence") falls outside it and gets confirmed. */
const COMMON_NAMES = new Set([
  // AU/UK/US common
  "kevin", "david", "dave", "john", "michael", "mike", "james", "jim", "daniel", "dan",
  "sam", "ben", "chris", "luke", "jack", "ryan", "josh", "matt", "matthew", "tom", "thomas",
  "nick", "nicholas", "pat", "patrick", "paul", "peter", "pete", "mark", "marco", "marcus",
  "andrew", "andy", "adam", "aaron", "alex", "anthony", "tony", "brian", "bruce", "charlie",
  "craig", "dean", "eric", "frank", "gary", "george", "greg", "harry", "henry", "ian",
  "jason", "jeff", "joe", "joseph", "kyle", "liam", "lucas", "martin", "nathan", "oliver",
  "oscar", "owen", "phil", "robert", "rob", "roger", "ross", "scott", "sean", "shane",
  "simon", "stephen", "steve", "stuart", "travis", "will", "william", "zac", "zach",
  "sarah", "sara", "emma", "zoe", "jess", "jessica", "emily", "sophie", "sophia", "olivia",
  "kate", "katie", "kathy", "laura", "lucy", "mia", "ella", "chloe", "grace", "hannah",
  "amy", "anna", "bella", "claire", "clare", "ruby", "lily", "maya", "mila", "nina",
  "tara", "willa", "gina", "june", "may", "june", "holly", "julia", "karen", "linda",
  "megan", "nicole", "rachel", "rebecca", "becky", "sally", "tina", "wendy", "delia",
  // common international (incl. South-Asian, so "Raju"/"Priya" are trusted)
  "raju", "priya", "dev", "deepak", "yusuf", "nadia", "omar", "umar", "ali", "amir",
  "aisha", "fatima", "hassan", "imran", "khan", "mohammed", "mohammad", "ahmed", "arjun",
  "ananya", "aarav", "rahul", "ravi", "sanjay", "sunil", "vijay", "neha", "pooja", "sana",
  "wei", "li", "chen", "ming", "yuki", "hiro", "kenji", "sofia", "maria", "jose", "juan",
  "carlos", "diego", "luis", "pedro", "ana", "elena", "ivan", "nikolai", "igor", "silas",
]);

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
  /** Booking provenance written to reservations.source. Defaults to "phone";
   * set to "cekura_test" for synthetic Cekura test calls so test bookings are
   * isolated and auto-cleanable (never mixed with genuine reservations). */
  source?: string;
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
  | "CONFIRM_BOOKING_CHANGE"
  | "COLLECT_EXTRAS"
  | "CONFIRM_NAME"
  | "SPELL_NAME"
  | "CONFIRM_PHONE"
  | "CONFIRMED"
  | "POST_CONFIRM"
  | "FIND_BOOKING"
  | "CANCEL_CONFIRM"
  | "MODIFY_WHAT"
  | "CONFIRM_DATE"
  | "HOLD_NAME"
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

/** The surface the voice session drives, implemented by BOTH the deterministic
 * ReservationMachine and the LLM ConversationalReservationBrain so either can be
 * selected behind the BOOKING_BRAIN flag with no change at the call site. */
export interface ReservationBrain {
  readonly reservation: Reservation | null;
  opening(opts?: { recordingNotice?: boolean }): string;
  next(text: string): Promise<ReservationTurn>;
  debug(): ReservationDebug;
  /** Re-ask the current question for the silence watchdog (state-aware). */
  gentleReprompt(): string;
  /** True while a multi-step recovery (e.g. name spelling / name confirmation) is
   * in progress — the silence watchdog must NOT end the call mid-flow (Kevin
   * 2026-10-10 silence rule). Optional: the deterministic machine may omit it. */
  midCriticalFlow?(): boolean;
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

/** The greeting variants, shared by the deterministic machine AND the LLM
 * conversational brain so both speak byte-identical openings and hit the same
 * warmed TTS cache. `notice` is "" or the recording-notice clause. */
export function reservationGreetingVariants(restaurantName: string, notice: string): string[] {
  return [
    `Hello, and thanks so much for calling ${restaurantName}.${notice} I'd be happy to help — are you looking to book a table?`,
    `Hi there — thanks for calling ${restaurantName}.${notice} Lovely to hear from you. Are you calling to book a table?`,
    `Good day, and thanks for calling ${restaurantName}.${notice} I'd be glad to help — would you like to book a table?`,
  ];
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
  /** Two conflicting dates [alreadyCaptured, newlyHeard] awaiting the caller's
   * pick, and the step to resume once resolved (spec: ambiguous date → clarify). */
  private pendingDateOptions: [string, string] | undefined;
  private resumeAfterDate: ReservationState | undefined;
  /** Gentle "anything else?" re-offers at POST_CONFIRM before we ring off, and a
   * count of "hang on / one sec" distractions, so we hold then offer a call-back. */
  private postConfirmReprompts = 0;
  private busyCount = 0;
  private nameReasks = 0;
  private phoneReasks = 0;
  private dateReasks = 0;
  private timeReasks = 0;
  private partyReasks = 0;
  private confirmReasks = 0;
  private altReasks = 0;         // OFFER_ALTERNATIVES re-asks
  private confirmDateReasks = 0; // CONFIRM_DATE (two-date clarify) re-asks
  private cancelReasks = 0;      // CANCEL_CONFIRM re-asks
  private modifyReasks = 0;      // MODIFY_WHAT re-asks
  private holdNamePending?: string; // a hold-note name read back, awaiting confirmation
  private nameTurns = 0;            // HARD cap across the whole name sub-dialog (no loop)
  private escalatingConfirm = false; // in the call-back read-back/confirm beat
  // Global loop-breaker: consecutive slot re-ask turns with NO booking progress.
  private noProgressTurns = 0;
  private lastProgressSig = "";
  /** A party size we heard but aren't sure of, awaiting a yes/no ("Four people?"). */
  private pendingParty: number | undefined;
  /** A doubtful name read back for confirmation / spelling, not yet stored. */
  private pendingName: string | undefined;
  /** Two plausible counts from "four or five", awaiting which one. */
  private ambiguousParty: number[] | undefined;
  /** The last question we asked, for a gentle silence re-prompt (spec §11). */
  private lastPrompt = "";
  /** Warm, varied acknowledgers so the flow feels like a friendly receptionist,
   * not a clipped form (Kevin: don't sound rude/jumpy). Rotated so two in a row
   * never repeat. */
  private readonly acks = ["Lovely", "Of course", "Wonderful", "No worries", "Certainly", "That's lovely"];
  private ackIdx = 0;
  private ack(): string { return this.acks[this.ackIdx++ % this.acks.length]!; }
  /** Pick a phrasing variant at random so two calls don't sound identical (Kevin:
   * "make it special and different from the other normal call"). */
  private pick(arr: string[]): string { return arr[Math.floor(Math.random() * arr.length)]!; }
  /** A warm "I'm sorry…" to fold onto the FRONT of the next thing we say, set when
   * the caller sounds unhappy (consumed once, in say()). Kevin 2026-10-06: console
   * the customer, don't plough on. */
  private pendingConsole: string | undefined;
  /** How many times we've consoled this call, and on which turn last — so we don't
   * say "sorry" every single turn (robotic) but still re-acknowledge if it persists. */
  private consoledCount = 0;
  private lastConsoledTurn = -10;
  private turnCount = 0;
  /** Asked the proactive occasion / seating / dietary question once per booking. */
  private askedOccasion = false;
  private askedSeating = false;
  private askedDietary = false;
  /** Offered to use the caller-ID number once, so we don't re-ask it. */
  private phoneConfirmed = false;
  /** Offered to HOLD the booking when the caller gave a vague/range date ("within
   * two weeks") rather than a bookable day — so a second non-committal reply closes
   * warmly instead of re-offering the hold (Kevin 2026-10-06). */

  constructor(private ctx: ReservationContext) {}

  /** The greeting variants (single source of truth, so the TTS pre-cache can warm
   * the exact strings — see fixedSpeech). `notice` is "" or the recording notice.
   * Delegates to the shared module function so the LLM brain speaks the identical
   * strings and the same warmed cache is hit regardless of which brain is active. */
  private static greetingVariants(restaurantName: string, notice: string): string[] {
    return reservationGreetingVariants(restaurantName, notice);
  }

  /** The opening line, spoken before the caller's first utterance (spec §10):
   * short, warm, reservations-framed. Recording notice folded in when required. */
  opening(opts: { recordingNotice?: boolean } = {}): string {
    const notice = opts.recordingNotice ? " This call may be recorded." : "";
    const line = this.pick(ReservationMachine.greetingVariants(this.ctx.restaurantName, notice));
    this.lastPrompt = "Are you looking to book a table?";
    return line;
  }

  /** Every FIXED, invariant line worth pre-synthesising so it plays INSTANTLY from
   * cache instead of a per-call ElevenLabs round-trip (the start/end lag Kevin
   * reported 2026-10-07). The greeting variants (notice on + off) and the set closes
   * that carry no caller-specific words. Lines with a name/number/date vary per call
   * and are deliberately excluded. Keep the closing strings here in sync with the
   * handlers that speak them. */
  static fixedSpeech(restaurantName: string): string[] {
    const out: string[] = [];
    for (const notice of ["", " This call may be recorded."]) {
      out.push(...ReservationMachine.greetingVariants(restaurantName, notice));
    }
    out.push(
      // Vague-date hold + close (handleDate) — fixed, no caller-specific words.
      "No problem at all — I'll hold a table for you around then. Whenever you've settled on the exact day, just give us a quick ring back and we'll lock it straight in. Thanks so much for calling!",
      // Name-less warm goodbye (warmGoodbye fallback).
      "It's my pleasure — have a wonderful day, and thanks so much for calling!",
    );
    return out;
  }

  /** Re-ask the CURRENT question for the silence watchdog — state-aware, not a
   * generic "take your time" timer phrase (Kevin: that felt disconnected). */
  gentleReprompt(): string {
    // At the optional-preferences stage, a slow caller shouldn't be re-read the
    // full question (felt naggy/rude on the AU test). Invite answer-or-proceed.
    if (this.state === "COLLECT_EXTRAS") {
      return "No rush — anything you'd like me to note, or shall I go ahead and lock it in?";
    }
    return this.lastPrompt || "What can I help you with — a booking?";
  }

  /** Queue a warm, human apology for the front of the next line. Varied so it never
   * sounds canned, and rate-limited so we don't say "sorry" on every single turn —
   * but a STRONG complaint is always acknowledged (Kevin 2026-10-06: console the
   * customer, make them happy). */
  private noteDispleasure(mood: "strong" | "mild"): void {
    // Don't pile apology on apology turn-after-turn for mild grumbles.
    if (mood === "mild" && this.turnCount - this.lastConsoledTurn < 2) return;
    this.lastConsoledTurn = this.turnCount;
    this.consoledCount++;
    if (mood === "strong") {
      this.pendingConsole = this.consoledCount >= 2
        ? "I'm genuinely sorry — I understand your frustration, and I want to get this right for you."
        : this.pick([
            "I'm really sorry — that's not the experience I want you to have. Let me make this quick and easy.",
            "I'm so sorry about that. Let me sort this out for you properly, right now.",
          ]);
      return;
    }
    this.pendingConsole = this.pick([
      "I'm sorry about that — let me make this nice and quick.",
      "Of course — I won't labour it, let me get you sorted.",
      "Sorry, I don't want to muck you about — let's keep this simple.",
    ]);
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
    // Fold a pending "I'm sorry…" onto the front of this line (set when the caller
    // sounded unhappy), so we console BEFORE carrying on — once per occurrence.
    if (this.pendingConsole) {
      say = `${this.pendingConsole} ${say}`;
      this.pendingConsole = undefined;
    }
    // Remember the question so the silence watchdog re-asks THIS one. Grab the last
    // sentence ending in "?", even when a non-question clause follows it ("...lock
    // that in? Or change anything, just say.") — otherwise the watchdog re-asks a
    // stale earlier question (live call 2026-10-05: after the confirm-to-lock line
    // it re-asked the occasion question and the call stalled with no booking).
    if (!endCall && say.includes("?")) {
      const sentences = say.trim().split(/(?<=[.?!])\s+/);
      const lastQ = [...sentences].reverse().find((s) => s.includes("?"));
      if (lastQ) this.lastPrompt = lastQ.trim();
    }
    return { say, kind, endCall };
  }

  async next(text: string): Promise<ReservationTurn> {
    this.turnCount++;
    // Food ordering is out of scope in every pre-confirmed state (spec §1).
    if (this.state !== "CONFIRMED" && this.state !== "END" && isFoodOrderAttempt(text)) {
      return this.say(
        "I can only help with table reservations on this line — did you want to book a table?",
        "decline_food",
      );
    }

    // The caller sounds unhappy / frustrated — console them warmly BEFORE carrying
    // on, and if they're impatient at the optional-preferences stage, drop the rest
    // of the niceties and go straight to confirming (Kevin 2026-10-06: "the customer
    // is saying not happy but the ai is so rude and not even consoling… at least make
    // them happy", "asking the preference so much"). The console phrase is folded onto
    // the next line by say(); state/flow is untouched otherwise.
    if (this.state !== "END") {
      const mood = detectDispleasure(text);
      if (mood) {
        this.noteDispleasure(mood);
        // Impatient during the optional extras? Stop asking — skip to confirm.
        if (this.state === "COLLECT_EXTRAS") {
          this.askedOccasion = true;
          this.askedSeating = true;
          this.askedDietary = true;
        }
      }
    }

    // Caller asks us to repeat / read the booking back — restate it (or what
    // we've got so far) and stay where we are, never ignore it (Kevin #1). Only
    // when there's something to repeat (not at the greeting / before any detail).
    const haveSomething = this.reservation !== null || this.draft.date !== undefined || this.draft.time !== undefined || this.draft.partySize !== undefined || this.draft.name !== undefined;
    if (this.state !== "END" && this.state !== "GREETING" && haveSomething && detectRepeatRequest(text)) return this.handleRepeat();

    // Caller is distracted / talking to someone else / asks us to hold — be
    // gracious: hold once, then offer a call-back rather than barging on (Kevin #4).
    if (this.state !== "END" && this.state !== "GREETING" && detectBusy(text)) return this.handleBusy();

    // An EXPLICIT "change the date/time/number/name" at ANY point of the booking must
    // be honoured — re-open that slot (or apply a value given in the same breath),
    // NEVER mistaken for a failed name/answer (live India call 2026-10-08: "can you
    // change the date?" at the name step spiralled to a booking under "Guest").
    const CHANGE_STATES = new Set([
      "COLLECT_DATE", "COLLECT_TIME", "COLLECT_PARTY_SIZE", "CONFIRM_PARTY",
      "COLLECT_NAME", "CONFIRM_NAME", "SPELL_NAME", "COLLECT_PHONE", "CONFIRM_PHONE",
      "COLLECT_EXTRAS", "CONFIRM_DETAILS", "CONFIRM_BOOKING_CHANGE", "OFFER_ALTERNATIVES",
      "POST_CONFIRM", "HOLD_NAME",
    ]);
    if (CHANGE_STATES.has(this.state)) {
      const changeSlot = detectChangeRequest(text);
      if (changeSlot) return this.handleChangeRequest(changeSlot, text);
    }

    // A clear "cancel / forget it" at ANY point of an in-progress booking — handle
    // it like a real receptionist would: drop it on the spot (Kevin: "if he
    // suddenly says cancel, cancel it"). If the booking was already created this
    // call, cancel the record; otherwise just don't book. (The cancel-an-EXISTING-
    // booking flow at the greeting is left to detectIntent, hence GREETING + the
    // find/cancel/modify states are excluded here.)
    const abandonInProgress =
      !["GREETING", "END", "FIND_BOOKING", "CANCEL_CONFIRM", "MODIFY_WHAT", "CONFIRM_DATE"].includes(this.state) &&
      /\b(cancel|scrap (?:it|that|the booking|the whole thing)|forget (?:it|the booking|the whole thing)|do not book|don'?t book)\b/i.test(text) &&
      !/\b(?:don'?t|do not|no need to|not)\s+cancel\b/i.test(text);
    if (abandonInProgress) {
      if (this.reservation) {
        let cancelled = false;
        try {
          cancelled = Boolean(await cancelReservation(this.ctx.db, this.reservation.id));
        } catch {
          this.state = "END";
          return this.say("No problem — I'll get the team to make sure that's cancelled for you. Thanks for calling.", "cancelled_same_call", true);
        }
        this.reservation = null;
        this.state = "END";
        return this.say(
          cancelled ? "No worries — I've cancelled that booking. Thanks so much for calling." : "That booking's already cancelled. Thanks for calling.",
          "cancelled_same_call",
          true,
        );
      }
      this.state = "END";
      return this.say("No worries at all — I won't book anything in. Give us a call back whenever suits and we'll sort your table. Cheers!", "booking_abandoned", true);
    }

    // A different date named (no correction cue) during a later collection step
    // clashes with what we already have — clarify instead of guessing (Kevin #5).
    if (["COLLECT_TIME", "COLLECT_PARTY_SIZE", "CONFIRM_PARTY", "COLLECT_NAME", "COLLECT_PHONE"].includes(this.state)) {
      const clash = this.checkDateConflict(text);
      if (clash) return clash;
    }

    // Info layer: answer a factual enquiry (hours / location) from real data,
    // then carry on where we were. Uses distinctive phrasings that don't collide
    // with slot answers, so it's safe to check in any pre-confirmed state.
    if (this.state !== "CONFIRMED" && this.state !== "END") {
      const info = detectInfoQuery(text);
      if (info) return this.handleInfo(info);
      // Caller wants a real human / manager — can't transfer on this line, so take
      // details for a call-back rather than carrying on (curveball survey 2026-10-06).
      if (detectHumanRequest(text)) return this.beginEscalation();
      // "Are you a robot / a real person?" — answer honestly, then steer back.
      if (detectBotQuestion(text)) return this.handleBotQuestion();
      // A question the booking line can't help with (parking, payment, prices, dress
      // code, wifi, pets, walk-ins) — steer gracefully instead of a non-sequitur.
      // Gated on a question cue so a bare name ("Park") isn't mistaken for one.
      const topic = detectUnsupportedTopic(text);
      if (topic && /\b(do|does|did|is|are|can|could|would|will|have|got|take|what|how|any|where|when|much|price|cost)\b/i.test(text)) {
        return this.handleUnsupported(topic);
      }
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
    // A request volunteered at the confirm beat ("actually, by the window") — note it
    // warmly and re-ask the lock question BRIEFLY. Don't re-recite the whole booking
    // on every little addition — the caller just heard it, and re-reading it two or
    // three times felt like being talked at (Kevin 2026-10-05).
    if (extraAck && this.state === "CONFIRM_DETAILS") {
      return this.say(
        `${extraAck}. Happy for me to lock that in, or would you like to change anything?`,
        "confirm_booking",
      );
    }

    const before = this.state;
    let turn = await this.route(cleaned || text);
    // A volunteered note folds its ack into the next line: a re-asked question (the
    // handler stayed put) OR the confirm beat (a note given at the special-touches
    // turn pushed us straight to confirm). Acking the thing the caller just said is
    // feedback, not a redundant full re-read (Kevin 2026-10-05).
    if (extraAck && (turn.kind === "confirm_booking" || (this.state === before && /^ask_/.test(turn.kind)))) {
      turn = { ...turn, say: `${extraAck}. ${turn.say}` };
    } else {
      // A NEW / unexpected off-topic QUESTION we couldn't act on for the current slot
      // (we didn't move on and it wasn't a known aside): acknowledge it like a person
      // and still steer back to the question, rather than a blunt re-ask that ignores
      // it (Kevin 2026-10-06: "if new curveballs are asked, face it and reply
      // normally"). Only fires when NOTHING parsed (state unchanged, a plain re-ask)
      // so a question that DOES carry the answer ("is seven ok?") is handled normally.
      const REASK_KINDS = new Set(["ask_date", "ask_time", "ask_party", "ask_name", "ask_phone", "ask_phone_dtmf", "reprompt"]);
      if (
        this.state === before &&
        REASK_KINDS.has(turn.kind) &&
        this.isBareQuestion(text) &&
        !/^(i'?m not sure|sorry|no worries|of course|just so|apolog)/i.test(turn.say)
      ) {
        turn = { ...turn, say: `That's one the team can help you with when you're in — ${turn.say[0]!.toLowerCase()}${turn.say.slice(1)}` };
      }
    }
    return this.guardAgainstLoop(turn);
  }

  /** The booking's filled slots — used to detect whether a turn made any progress. */
  private slotSig(): string {
    const d = this.draft;
    return `${d.date ?? ""}|${d.time ?? ""}|${d.partySize ?? ""}|${d.name ?? ""}|${d.phone ?? ""}|${this.reservation ? "R" : ""}`;
  }

  /** GLOBAL loop-breaker (Kevin 2026-10-07: "no more looping should be occurred").
   * Each slot already bounds its own re-asks, but as an absolute guarantee no call
   * can ever cycle — same-state OR across states, foreseen or not — track consecutive
   * SLOT RE-ASK turns that made NO booking progress (no slot filled/changed, no
   * booking created). After a handful, bow out to a staff call-back rather than loop.
   * Terminals and informational answers (read-backs, hours, console) never trip it. */
  private guardAgainstLoop(turn: ReservationTurn): Promise<ReservationTurn> {
    if (turn.endCall) { this.noProgressTurns = 0; return Promise.resolve(turn); }
    const STALL_KINDS = new Set([
      "ask_date", "ask_time", "ask_party", "ask_party_dtmf",
      "ask_name", "ask_phone", "ask_phone_dtmf", "reprompt", "confirm_change",
      // Every other re-ask kind that keeps the booking in place, so the backstop
      // covers them too even though each now also bounds itself locally (audit
      // 2026-10-07 found these could cycle): availability, the two-date clarify, the
      // cancel/modify lookups, and the doubtful party/name read-backs.
      "alternatives", "unavailable", "confirm_date", "confirm_party", "confirm_name",
      "spell_name", "cancel_confirm", "modify_what", "greeting_help", "hold_name",
      "escalate_name", "escalate_phone", "escalate_confirm",
    ]);
    const sig = this.slotSig();
    if (sig !== this.lastProgressSig) {
      this.lastProgressSig = sig;
      this.noProgressTurns = 0;
    } else if (STALL_KINDS.has(turn.kind)) {
      this.noProgressTurns++;
      if (this.noProgressTurns >= 6) {
        this.noProgressTurns = 0;
        // Bow out to the same graceful staff call-back every other escalation uses,
        // rather than ever cycle.
        return this.beginEscalation();
      }
    }
    return Promise.resolve(turn);
  }

  /** A caller utterance that reads as a QUESTION (starts with a question word or
   * ends with "?"). Used only as a last resort — to soften a re-ask when an
   * off-topic question couldn't be acted on. */
  private isBareQuestion(text: string): boolean {
    if (/\?\s*$/.test(text.trim())) return true;
    return /^(?:do|does|did|is|are|am|can|could|would|will|shall|should|have|has|had|what|whats|how|hows|why|when|where|who|whose|whom|which|any|got)\b/i.test(text.trim());
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
      case "CONFIRM_NAME": return this.handleConfirmName(text);
      case "SPELL_NAME": return this.handleSpellName(text);
      case "COLLECT_PHONE": return this.handlePhone(text);
      case "CONFIRM_PHONE": return this.handleConfirmPhone(text);
      case "COLLECT_EXTRAS": return this.handleExtras(text);
      case "CONFIRM_DETAILS": return this.handleConfirmBooking(text);
      case "CONFIRM_BOOKING_CHANGE": return this.handleConfirmBookingChange(text);
      case "POST_CONFIRM": return this.handlePostConfirm(text);
      case "FIND_BOOKING": return this.handleFindBooking(text);
      case "CANCEL_CONFIRM": return this.handleCancelConfirm(text);
      case "MODIFY_WHAT": return this.handleModifyWhat(text);
      case "CONFIRM_DATE": return this.handleConfirmDate(text);
      case "HOLD_NAME": return this.handleHoldName(text);
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
      acks.push(`A ${seat} sounds lovely — I'll make a note of that`);
      cleaned = cleaned
        .replace(/\b(?:by|near|next to|beside)?\s*(?:the\s+)?window(?:\s+seat|\s+table)?\b/gi, " ")
        .replace(/\b(?:outside|outdoors?|out door|alfresco|courtyard|patio|garden)\b/gi, " ")
        .replace(/\b(?:indoors?|inside)\b/gi, " ")
        .replace(/\bbooth\b/gi, " ")
        .replace(/\b(?:somewhere\s+)?(?:quiet|secluded)(?:\s+table|\s+spot|\s+corner)?\b/gi, " ");
    }
    const special = detectSpecialRequest(text);
    if (special && !(this.draft.specialRequests ?? "").includes(special)) {
      this.draft.specialRequests = [this.draft.specialRequests, special].filter(Boolean).join("; ");
      // Speak a clean, warm confirmation — never echo the raw internal note (it can
      // read oddly, e.g. "allergy noted"). An occasion gets a warmer touch.
      const occ = special.match(/\b(birthday|anniversary|engagement|graduation|reunion|christening)\b/);
      const article = occ && /^[aeiou]/i.test(occ[1]!) ? "An" : "A";
      acks.push(occ ? `${article} ${occ[1]} — how lovely, I'll make a note of that` : "Of course — I'll make a note of that for you");
      cleaned = cleaned
        .replace(/\b(?:i'?m|we'?re|i am)?\s*allerg(?:ic|y)(?:\s+to)?\s+[a-z\s]*?(?=[.,]|$|\bplease\b|\band\b|\bthanks?\b)/gi, " ")
        .replace(/\b(vegan|vegetarian|veggie|gluten[\s-]?free|coeliac|celiac|halal|kosher|high\s?chair|highchair|wheelchair|accessible|accessibility|mobility|pram|stroller|buggy|pushchair|birthday|anniversary|engagement|celebration|celebrating)\b/gi, " ");
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

  /** The resume tail used when we answer an aside — re-ask the current question, or
   * offer to book if we're still at the greeting. */
  private resumeTail(): string {
    return this.state === "GREETING" || !this.lastPrompt
      ? " Would you like to book a table?"
      : ` ${this.lastPrompt}`;
  }

  /** "Are you a robot / a real person?" — answer honestly (we don't pretend to be a
   * person), then carry on. */
  private handleBotQuestion(): ReservationTurn {
    // Keep it warm and natural — don't announce "automated assistant" (breaks the
    // human feel Kevin wants), and don't claim to be a person either. Just steer
    // back warmly like a receptionist would.
    return this.say(
      `You're through to the Meat Box — happy to help.${this.resumeTail()}`,
      "bot_question",
    );
  }

  /** A question the booking line can't answer (parking / payment / prices / dress
   * code / wifi / pets / walk-ins) — say so warmly and steer back to the booking;
   * the team can help with the detail when they're in. */
  private handleUnsupported(topic: string): ReservationTurn {
    return this.say(
      `I'm just the booking line, so I can't help with ${topic}, sorry — the team will sort that when you're in.${this.resumeTail()}`,
      "out_of_scope_info",
    );
  }

  /** Opening hours for the day-of-week of an ISO date, or null if closed that day. */
  private hoursForDate(iso?: string): { opensAt: string; closesAt: string } | null {
    if (!iso) return null;
    const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
    const r = (this.ctx.hours ?? []).find((x) => x.dayOfWeek === dow);
    if (!r || r.isClosed || !r.opensAt || !r.closesAt) return null;
    return { opensAt: r.opensAt.slice(0, 5), closesAt: r.closesAt.slice(0, 5) };
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
    if (!gotDate && !gotParty && !gotTime) {
      if (isNo(text)) {
        return this.say(
          "No worries. I can book you a table, or change one you've already got — what would you like?",
          "greeting_help",
        );
      }
      // An opener we couldn't make sense of as a booking — a genuinely odd question,
      // or (common on an international line) garble/noise misread as one. Steer warmly
      // WITHOUT presuming they asked something we can't answer: the old "so I may not
      // have that" made a simple mishear sound like a rejected question and stacked an
      // awkward extra line onto the greeting (live India call 2026-10-07). Known
      // off-topic questions (parking, catering, hours, etc.) are already handled above.
      if (intent === "unknown" && this.isBareQuestion(text)) {
        return this.say(
          "I'm the booking line here — I can book you a table or change an existing one. What would you like to do?",
          "greeting_help",
        );
      }
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

  /** A real date token is present (so a bare number like "8" in "8pm" is NOT
   * mistaken for "the 8th"). Only an actual day/month/relative word counts. */
  private hasDateWord(text: string): boolean {
    return /\b(today|tonight|tomorrow|tomorro|mon(day)?|tue(s|sday)?|wed(nesday)?|thur?(sday)?|fri(day)?|sat(urday)?|sun(day)?|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|next\s+week|this\s+week|fortnight|weekend|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}[\/\-]\d{1,2}\b)\b/i.test(text);
  }

  /** A time cue is present (so a bare number is an hour, not a party size). Spoken
   * and British forms count too — "seven pm" (word + am/pm), "half past seven",
   * "quarter to eight", "seven o'clock", "noon" — so a time is never mistaken for
   * a party size (accent sweep B1/D3: "seven pm"/"half past seven" → party 7). */
  private hasTimeCue(text: string): boolean {
    return (
      /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:am|pm|a\.m\.|p\.m\.)\b/i.test(text) ||
      /\b\d{1,2}[:.h]\d{2}\b/.test(text) ||
      /\bo'?clock\b/i.test(text) ||
      /\b(?:half|quarter)\s+(?:past|to|after)\b/i.test(text) ||
      /\b(?:at|around|about|by|to)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midday|midnight|half|quarter)(?!\s*(?:weeks?|days?|months?|fortnights?|years?|hours?|minutes?|mins?))\b/i.test(text) ||
      /\b(?:noon|midday|midnight)\b/i.test(text)
    );
  }

  /** The reply is clearly a TIME ("seven pm", "half past seven", "seven
   * o'clock") carrying no explicit party phrase — i.e. a misheard or duplicated
   * time landing on the party step, which must NOT be read as a party size.
   * (Accent sweep D3: a repeated "Seven PM" was booking a table for 7.) */
  private isStrayTime(text: string): boolean {
    // Explicit time MARKERS only — a bare colon form like "4:00" is how STT
    // renders a spoken party number ("four") at this step (live call 8d55f5f8),
    // so it must stay a valid party answer, not a stray time.
    const timeMarker =
      /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:am|pm|a\.m\.|p\.m\.)\b/i.test(text) ||
      /\bo'?clock\b/i.test(text) ||
      /\b(?:half|quarter)\s+(?:past|to|after)\b/i.test(text) ||
      /\b(?:noon|midday|midnight)\b/i.test(text);
    if (!timeMarker) return false;
    const explicitParty =
      /\b(?:party|group|table|booking)\s+(?:of|for)\s+\w+/i.test(text) ||
      /\b\w+\s+(?:people|persons?|guests?|pax|adults|of\s+us|heads|covers)\b/i.test(text);
    return !explicitParty;
  }

  /** A LATE correction: the caller restates an ALREADY-captured slot with a
   * correction cue ("actually make it six", "no sorry make it Thursday") during a
   * later step. Only an explicit correction retroactively changes a filled slot —
   * a bare restatement does not. Returns human acks for what changed ([] if
   * nothing). Disambiguates party vs time: a bare "make it six" is a party change
   * (no time cue); "eight pm" is a time change (never read as party). (§ corrections) */
  private applyLateCorrection(text: string): { acks: string[]; cleaned: string } {
    const acks: string[] = [];
    let cleaned = text;
    const timeCue = this.hasTimeCue(text);
    const corrCue = /\b(actually|instead|rather|make it|change (?:it|that)(?:\s+to)?|scrap|i mean|not|sorry|no)\b/i.test(text);
    const partyPhrase = /\b(?:party|group|table|booking)\s+(?:of|for)\s+\w+|\b\w+\s+(?:people|persons?|guests?|pax|adults|of us)\b/i.test(text);
    // DATE — an explicit correction to a REAL date token that differs (never a
    // bare number: "8" in "8pm" must not become "the 8th").
    if (this.draft.date !== undefined && corrCue && this.hasDateWord(text)) {
      const d = normaliseDate(text, {
        now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays,
      });
      if (d.date && d.date !== this.draft.date) { this.draft.date = d.date; acks.push(`change it to ${speakDate(d.date)}`); }
    }
    // TIME — only with an explicit time cue, differing from the captured time.
    if (this.draft.time !== undefined && timeCue) {
      const saved = this.draft.time;
      this.draft.time = undefined;
      const got = this.applyTimeFrom(text);
      if (got && this.draft.time && this.draft.time !== saved) acks.push(speakTime(this.draft.time));
      else this.draft.time = saved;
    }
    // PARTY — a correction cue or party phrase, NO time cue, differing value. But at
    // the TIME step a BARE number (no explicit "people"/"party of") is the TIME, not
    // a party change — so "no, eight" means 8 o'clock, never a table for 8 (audit
    // 2026-10-07: "no, eight" silently overwrote the party size).
    const bareNumberIsTime = this.state === "COLLECT_TIME" && !partyPhrase;
    if (this.draft.partySize !== undefined && !timeCue && (corrCue || partyPhrase) && !bareNumberIsTime) {
      const p = interpretPartySize(text, { expectingParty: true });
      if (p.kind === "value" && p.value !== this.draft.partySize) {
        this.draft.partySize = p.value;
        acks.push(`make it ${numberWord(p.value)}`);
        // Strip the correction fragment so a name said in the same breath
        // ("make it six, the name's Tara") still parses from the remainder.
        cleaned = cleaned
          .replace(/\b(actually,?\s*)?(make it|change (?:it|that)(?:\s+to)?|scrap that,?\s*)\s*(a\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(\s+(?:people|persons?|guests?|of us|pax|adults))?/gi, " ")
          .replace(/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:people|persons?|guests?|of us|pax|adults)\b/gi, " ")
          .replace(/\bnot\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi, " ")
          .replace(/\s{2,}/g, " ").trim();
      }
    }
    return { acks, cleaned };
  }

  /** A direct slot change stated against a CONFIRMED booking (POST_CONFIRM),
   * e.g. "the party is for six, not four" / "actually make it 8pm" — detected as a
   * concrete change (not just a vague "modify" intent) and applied to the record. */
  private extractReservationChange(text: string): { date?: string; time?: string; partySize?: number } {
    const r = this.reservation!;
    const changes: { date?: string; time?: string; partySize?: number } = {};
    const timeCue = this.hasTimeCue(text);
    // A clear sign-off is NEVER an edit. A stray temporal word inside a goodbye
    // ("no, that's all for today", "cheers, see you tomorrow") must not silently
    // move the booking — only an explicit change cue overrides this. (Accent
    // sweep K1: "No, that's all for today" was moving the table to today.)
    const changeCue = /\b(actually|instead|rather|make it|change (?:it|that)(?:\s+to)?|move (?:it|that|the booking)?|push (?:it|that)|switch|shift|reschedule|can we (?:do|make|move|change|get|have|push)|could we|let'?s (?:do|make|move|change)|do it (?:on|for)|book it (?:for|on)|put it (?:to|on))\b/i.test(text);
    if ((detectDone(text) || isNo(text)) && !changeCue) return changes;
    // DATE — only a REAL date token AND an explicit change cue (a bare date word
    // post-confirm is incidental, e.g. "see you Friday"). Never a bare number
    // ("make it 8pm" must not become "the 8th").
    if (changeCue && this.hasDateWord(text)) {
      const d = normaliseDate(text, {
        now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays,
      });
      if (d.date && d.date !== r.reservationDate) changes.date = d.date;
    }
    if (timeCue) {
      const tm = normaliseTime(text);
      if (tm.time && tm.time !== r.reservationTime.slice(0, 5)) changes.time = tm.time;
    }
    if (!timeCue) {
      const corrCue = /\b(actually|instead|rather|make it|change (?:it|that)(?:\s+to)?|scrap|i mean|not|different)\b/i.test(text);
      const partyPhrase = /\b(?:party|group|table|booking)\s+(?:of|for)\s+\w+|\b\w+\s+(?:people|persons?|guests?|pax|adults|of us)\b/i.test(text);
      if (corrCue || partyPhrase) {
        const p = interpretPartySize(text, { expectingParty: true });
        if (p.kind === "value" && p.value !== r.partySize) changes.partySize = p.value;
      }
    }
    return changes;
  }

  /** Restate the booking (or progress so far) when the caller asks us to repeat,
   * without changing where we are. (Kevin #1 — a "say that again" was ignored.) */
  private handleRepeat(): ReservationTurn {
    if (this.reservation) {
      const r = this.reservation;
      const when = speakWhen(r.reservationDate, r.reservationTime.slice(0, 5), this.ctx.now(), this.ctx.timezone);
      return this.say(`Of course — I've got you down for ${r.partySize} ${when}, under ${r.customerName}. Is there anything else I can help you with?`, "repeat");
    }
    const parts: string[] = [];
    if (this.draft.partySize !== undefined) parts.push(`a table for ${numberWord(this.draft.partySize)}`);
    if (this.draft.date) parts.push(speakDate(this.draft.date));
    if (this.draft.time) parts.push(`at ${speakTime(this.draft.time)}`);
    if (this.draft.name) parts.push(`under ${this.draft.name}`);
    const summary = parts.length ? `No worries — so far I've got ${parts.join(", ")}. ` : "No worries. ";
    return this.say(`${summary}${this.lastPrompt || "What else can I get for the booking?"}`, "repeat");
  }

  /** The caller sounds distracted / asks us to hold. Hold graciously once; if it
   * happens again, invite a call-back rather than pushing on. (Kevin #4.) */
  private handleBusy(): ReservationTurn {
    this.busyCount += 1;
    if (this.busyCount >= 2) {
      this.state = "END";
      return this.say(
        "No worries at all — sounds like you've got a bit on. Give us a call back whenever suits and we'll get your table sorted. Cheers!",
        "busy_callback",
        true,
      );
    }
    return this.say("Of course, no rush — I'm here whenever you're ready.", "busy_hold");
  }

  /** The caller named a DIFFERENT date than the one already captured, with no
   * correction cue — don't silently keep or overwrite; ask which they meant.
   * (Kevin #5: "the weekend" then "3pm tomorrow" must be clarified.) Returns the
   * clarify turn, or null when there's no conflict. */
  private checkDateConflict(text: string): ReservationTurn | null {
    if (this.draft.date === undefined) return null;
    if (/\b(actually|instead|rather|make it|change (?:it|that)|scrap|i mean|not|sorry|no)\b/i.test(text)) return null; // explicit correction, handled elsewhere
    if (!this.hasDateWord(text)) return null;
    const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
    if (!d.date || d.date === this.draft.date) return null;
    this.pendingDateOptions = [this.draft.date, d.date];
    this.resumeAfterDate = this.state;
    this.state = "CONFIRM_DATE";
    return this.say(`Just to check — did you want ${speakDate(this.draft.date)} or ${speakDate(d.date)}?`, "confirm_date");
  }

  /** Honour an explicit "change the <slot>" at any point — apply a value given in the
   * same breath, else re-open that slot. Works pre-confirm (on the draft) and
   * POST_CONFIRM (modifies the live booking). Never mistakes it for a slot answer. */
  private async handleChangeRequest(slot: "date" | "time" | "party" | "name", text: string): Promise<ReservationTurn> {
    const dOpts = { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays };
    // Two days named ("change to Sunday or Monday") → clarify which, don't guess.
    if (slot === "date") {
      const two = this.twoDateOptions(text);
      if (two) return this.clarifyTwoDates(two, this.state === "POST_CONFIRM" ? "POST_CONFIRM" : "CONFIRM_DETAILS");
    }
    // Extract any value the caller gave alongside the change request.
    let newDate: string | undefined; let newTime: string | undefined;
    let newParty: number | undefined; let newName: string | undefined;
    if (slot === "date") { const d = normaliseDate(text, dOpts); if (d.date) newDate = d.date; }
    else if (slot === "time" && this.hasTimeCue(text)) { const r = normaliseTime(text); if (r.time) newTime = r.time; }
    else if (slot === "party") { const p = interpretPartySize(text, { expectingParty: true }); if (p.kind === "value") newParty = p.value; }
    else if (slot === "name") { const n = parseName(text); if (n) newName = n; }

    // POST_CONFIRM: modify the live reservation (or ask what to change it to).
    if (this.state === "POST_CONFIRM" && this.reservation) {
      const changes: { date?: string; time?: string; partySize?: number } = {};
      if (newDate) changes.date = newDate;
      if (newTime) changes.time = newTime;
      if (newParty !== undefined) changes.partySize = newParty;
      if (slot === "name" && newName) {
        this.reservation = { ...this.reservation, customerName: newName };
        return this.say(`Done — I've updated the name to ${newName}. Anything else, or are you all set?`, "modified");
      }
      if (Object.keys(changes).length) {
        try {
          const result = await modifyReservation(this.ctx.db, {
            reservationId: this.reservation.id, changes,
            hours: this.ctx.hours, settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
          });
          if ("reservation" in result) {
            this.reservation = result.reservation;
            const r = result.reservation;
            return this.say(`Done — that's now for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}. Anything else, or are you all set?`, "modified");
          }
          if ("unavailable" in result) {
            const alts = result.unavailable.alternatives.slice(0, 2).map(speakTime);
            return this.say(alts.length ? `That's not available, but I've got ${alts.join(" or ")}. Would either work?` : "That's not available, I'm afraid — is there another time that'd suit?", "modify_unavailable");
          }
        } catch {
          return this.say("I couldn't change that just now, so I've kept your booking as it was. Anything else?", "modify_failed");
        }
      }
      // No value given — take it into the modify flow and ask.
      this.candidates = [this.reservation];
      this.pendingAction = "modify";
      this.state = "MODIFY_WHAT";
      const askWhat = slot === "date" ? "what day would you like instead?" : slot === "time" ? "what time would you like instead?" : slot === "party" ? "how many people now?" : "what name should I put it under?";
      return this.say(`Of course — ${askWhat}`, "modify_what");
    }

    // PRE-confirm: update the draft. With a value → re-validate + re-confirm; without
    // → re-open that slot with a clean question (never loop — a real answer advances).
    if (slot === "date") {
      if (newDate && newDate !== this.draft.date) { this.draft.date = newDate; return this.resumeAfterChange(`No worries, I'll change it to ${speakDate(newDate)}.`); }
      this.draft.date = undefined; this.dateReasks = 0; this.state = "COLLECT_DATE";
      return Promise.resolve(this.say("Of course — what day would you like instead?", "ask_date"));
    }
    if (slot === "time") {
      if (newTime && newTime !== this.draft.time) { this.draft.time = newTime; return this.resumeAfterChange(`No worries, I'll move it to ${speakTime(newTime)}.`); }
      this.draft.time = undefined; this.timeReasks = 0; this.state = "COLLECT_TIME";
      return Promise.resolve(this.say("Of course — what time would you like instead?", "ask_time"));
    }
    if (slot === "party") {
      if (newParty !== undefined && newParty !== this.draft.partySize) { this.draft.partySize = newParty; return this.resumeAfterChange(`No worries, I'll make it ${numberWord(newParty)}.`); }
      this.draft.partySize = undefined; this.partyReasks = 0; this.pendingParty = undefined; this.state = "COLLECT_PARTY_SIZE";
      return Promise.resolve(this.say("Of course — how many people would it be?", "ask_party"));
    }
    // name
    if (newName) { this.draft.name = newName; this.pendingName = undefined; return this.resumeAfterChange(`No worries, I'll put it under ${newName}.`); }
    this.draft.name = undefined; this.pendingName = undefined; this.nameReasks = 0; this.nameTurns = 0; this.state = "COLLECT_NAME";
    return Promise.resolve(this.say("Of course — what name should I put it under?", "ask_name"));
  }

  /** After a slot was changed mid-flow: re-check availability + re-confirm when the
   * day/time/party are all set, else ask the next missing slot — with a brief ack. */
  private async resumeAfterChange(ack: string): Promise<ReservationTurn> {
    const ready = this.draft.date !== undefined && this.draft.time !== undefined && this.draft.partySize !== undefined;
    const t = ready ? await this.runAvailability() : await this.advanceBooking();
    return { ...t, say: `${ack} ${t.say}` };
  }

  /** Two DISTINCT days named in one reply ("Sunday or Monday", "Friday or Saturday")
   * — returns the two ISO dates to clarify between, or null. Only day-worded parts
   * count (so "5 or 6", bare numbers, are NOT read as the 5th/6th here). */
  private twoDateOptions(text: string): [string, string] | null {
    if (!/\b(?:or|either)\b|\//.test(text)) return null;
    const dOpts = { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays };
    const opts: string[] = [];
    for (const part of text.split(/\b(?:or|either)\b|\/|,/i).map((s) => s.trim()).filter(Boolean)) {
      if (!this.hasDateWord(part)) continue;
      const dd = normaliseDate(part, dOpts);
      if (dd.date && !opts.includes(dd.date)) opts.push(dd.date);
    }
    return opts.length >= 2 ? [opts[0]!, opts[1]!] : null;
  }

  /** Enter the two-date clarify: ask which of the two the caller wants, then resume
   * at `resumeState` (re-checks availability + re-confirms via advanceBooking). */
  private clarifyTwoDates(opts: [string, string], resumeState: ReservationState): Promise<ReservationTurn> {
    this.pendingDateOptions = opts;
    this.resumeAfterDate = resumeState;
    this.state = "CONFIRM_DATE";
    this.confirmDateReasks = 0;
    return Promise.resolve(this.say(
      `Which would you prefer — ${speakDate(opts[0])} or ${speakDate(opts[1])}?`,
      "confirm_date",
    ));
  }

  private handleConfirmDate(text: string): Promise<ReservationTurn> {
    const [optA, optB] = this.pendingDateOptions ?? ["", ""];
    let chosen: string | undefined;
    // Positional picks FIRST — "the first one" means option A, not "the 1st of the
    // month" (bug 2026-10-07: "the first one" resolved to Nov 1). Then a named day.
    if (/\b(first|former|earlier|the one|number one)\b/i.test(text) && !/\b(second|latter|later|other|last)\b/i.test(text)) chosen = optA;
    else if (/\b(second|latter|other|later|last)\b/i.test(text)) chosen = optB;
    if (!chosen) {
      const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
      if (d.date) chosen = d.date; // they named a day (one of the two, or a fresh one)
    }
    if (!chosen) {
      // Couldn't tell which of the two — re-ask once, then bow out to a call-back
      // rather than loop "A or B?" forever (audit 2026-10-07).
      this.confirmDateReasks++;
      if (this.confirmDateReasks >= 2) { this.confirmDateReasks = 0; return this.beginEscalation(); }
      return Promise.resolve(this.say(`Sorry — ${speakDate(optA)} or ${speakDate(optB)}?`, "confirm_date"));
    }
    this.confirmDateReasks = 0;
    this.draft.date = chosen;
    this.pendingDateOptions = undefined;
    this.state = this.resumeAfterDate ?? "COLLECT_TIME";
    this.resumeAfterDate = undefined;
    return this.advanceBooking();
  }

  /** A warm, personal sign-off (Kevin #3 — don't sound clipped/rude). If the caller
   * showed ANY displeasure during the call, close HUMBLY — never a cheery "Wonderful!"
   * over an unhappy customer (Kevin 2026-10-07: said "very bad", got "Wonderful"). */
  private warmGoodbye(): string {
    const name = this.reservation && this.reservation.customerName && this.reservation.customerName !== "Guest"
      ? `, ${this.reservation.customerName}` : "";
    if (this.consoledCount > 0) {
      this.pendingConsole = undefined; // the humble close already apologises — no double
      return this.reservation
        ? this.pick([
            `I'm sorry it wasn't smoother today${name} — your table's booked, and we'll make sure you're well looked after. Thanks for your patience.`,
            `Thanks for bearing with me${name} — you're booked in, and I'm sorry it was a bit of a struggle. We'll take good care of you.`,
          ])
        : this.pick([
            "I'm sorry it wasn't smoother today — please do call back whenever suits, and we'll take good care of you.",
            "Thanks for your patience, and sorry for the trouble — give us a call back anytime and we'll get you sorted.",
          ]);
    }
    if (this.reservation) {
      return this.pick([
        `It's my pleasure${name} — you're all set, and we'll see you then. Have a wonderful day, thanks so much for calling!`,
        `Brilliant${name} — all booked. See you then — have a lovely day, and thanks for calling!`,
        `Wonderful${name} — that's all sorted. We look forward to seeing you. Take care, and thanks for calling!`,
      ]);
    }
    return this.pick([
      "It's my pleasure — have a wonderful day, and thanks so much for calling!",
      "No worries at all — have a lovely day, and thanks for calling!",
      "Happy to help — take care, and thanks so much for calling!",
    ]);
  }

  /** Ask for the next missing booking slot, or run availability once all present. */
  private async advanceBooking(): Promise<ReservationTurn> {
    if (!this.draft.date) {
      this.state = "COLLECT_DATE";
      // Ease the caller in warmly — never a clipped "Which day suits you?" that feels
      // like being rushed into it (Kevin 2026-10-07: "beginning full rushing — make
      // the customer comfortable"). A gentle, unhurried invitation.
      return this.say(this.pick([
        "Lovely — I'd be glad to help you book a table. What day were you thinking of coming in?",
        "Wonderful — let's get you a table sorted. What day did you have in mind?",
        "Of course — I'd be happy to help with that. What day were you thinking of coming in?",
      ]), "ask_date");
    }
    // Echo the day back as we move to the time (reference-style confirmation).
    if (!this.draft.time) {
      this.state = "COLLECT_TIME";
      const d = speakDate(this.draft.date);
      return this.say(this.pick([
        `${d}, lovely. And what time were you thinking of coming in?`,
        `${d} — wonderful. And what time would you like to join us?`,
        `${d}, great. And what time would you like?`,
      ]), "ask_time");
    }
    // Echo the full day + date + time back as we move to the party size — so the
    // DATE is always confirmed out loud, even when the caller gave the date and time
    // in one breath ("after three weeks on Friday, 3pm") and we'd otherwise only
    // echo the time (live India call 2026-10-05: the date was never read back, so the
    // caller couldn't tell it had "Friday" right). Day + date must never be ambiguous.
    if (this.draft.partySize === undefined) {
      this.state = "COLLECT_PARTY_SIZE";
      const when = `${speakDate(this.draft.date)} at ${speakTime(this.draft.time)}`;
      return this.say(this.pick([
        `${when}, wonderful. And how many will be joining you?`,
        `${when} — lovely. How many will there be?`,
        `${when}, perfect. And how many shall I set the table for?`,
      ]), "ask_party");
    }
    return this.runAvailability();
  }

  private handleDate(text: string): Promise<ReservationTurn> {
    const dOpts = { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays };
    // TWO dates offered ("Friday or Saturday", "either Thursday or Friday") — don't
    // silently pick one; clarify which (Kevin 2026-10-07: be aware of day/date
    // confusion). A correction in the SECOND option ("Friday, actually Saturday")
    // wins instead. Mirrors how party handles "four or five".
    if (/\b(or|either)\b|\/|\b(actually|instead|rather|make it|i mean|scrap)\b/i.test(text)) {
      const parts = text.split(/\b(?:or|either)\b|\/|,/i).map((s) => s.trim()).filter(Boolean);
      const opts: { date: string; part: string }[] = [];
      for (const part of parts) {
        const dd = normaliseDate(part, dOpts);
        if (dd.date && !opts.some((o) => o.date === dd.date)) opts.push({ date: dd.date, part });
      }
      if (opts.length >= 2) {
        const last = opts[opts.length - 1]!;
        if (/\b(actually|instead|rather|make it|change (?:it|that)|no|scrap|i mean)\b/i.test(last.part)) {
          // the correction wins — take the corrected day
          this.dateReasks = 0;
          this.draft.date = last.date;
          this.applyExplicitPartyFrom(text);
          if (this.draft.time === undefined) this.applyTimeFrom(text);
          return this.advanceBooking();
        }
        this.pendingDateOptions = [opts[0]!.date, opts[1]!.date];
        this.resumeAfterDate = undefined; // after they pick, carry on to the time
        this.state = "CONFIRM_DATE";
        this.dateReasks = 0;
        return Promise.resolve(this.say(
          `Which would you prefer — ${speakDate(opts[0]!.date)} or ${speakDate(opts[1]!.date)}?`,
          "confirm_date",
        ));
      }
    }
    const r = normaliseDate(text, dOpts);
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
    // A VAGUE / undecided day ("after two weeks", "within two weeks", "not sure
    // yet"), OR a reply we couldn't read as a day after ONE gentle re-ask. We can't
    // reserve a specific table with no day — but rather than an empty "I'll hold a
    // table" that stores nothing (Kevin 2026-10-07: "without a name how will you hold
    // a table?"), take a FIRST NAME and leave a real callback note (name + the number
    // they're on) so the team can follow up and recognise them when they ring back.
    // Never re-ask the day. A real specific day is caught above (r.date) and books.
    if (detectVagueDate(text) || this.dateReasks >= 1) {
      this.dateReasks = 0;
      if (this.draft.name && this.draft.name !== "Guest") return this.finaliseHoldNote();
      this.state = "HOLD_NAME";
      return Promise.resolve(this.say(
        "No problem at all — I can't lock a specific table in without a day, but I'll make a note so the team can look after you. Can I grab your first name?",
        "hold_name",
      ));
    }
    // First reply we couldn't read as a day (dateReasks 0) — one gentle, unhurried
    // re-ask. A PAST / TOO_FAR concrete day names the reason; otherwise a soft catch.
    // The next non-day reply holds + closes (above), so there is never a loop.
    this.dateReasks++;
    if (r.error === "PAST") return Promise.resolve(this.say("That day's already passed — what day would you like?", "ask_date"));
    if (r.error === "TOO_FAR") return Promise.resolve(this.say("That's a bit too far ahead — what day would you like?", "ask_date"));
    return Promise.resolve(this.say("Sorry, I didn't quite catch the day — what day were you thinking of coming in?", "ask_date"));
  }

  /** Collect a first name for a CALL-BACK note (the caller hasn't settled on a day
   * OR a time). If, when asked for the name, they actually supply the MISSING piece
   * (a day when we had none, or a time when the day's set), they've decided —
   * resume the booking. Otherwise the heard name is READ BACK for confirmation before
   * it goes in the note — a phone STT mis-hear ("Joseph" -> "Youssef" on a poor line,
   * live India call 2026-10-08) must be catchable, not silently committed. */
  private handleHoldName(text: string): Promise<ReservationTurn> {
    // Decided the missing piece after all → resume the booking.
    if (!this.draft.date) {
      const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
      if (d.date) { this.draft.date = d.date; this.nameReasks = 0; this.holdNamePending = undefined; this.state = "COLLECT_TIME"; return this.advanceBooking(); }
    } else if (this.draft.time === undefined && this.hasTimeCue(text)) {
      const r = normaliseTime(text);
      if (r.time) { this.draft.time = r.time; this.nameReasks = 0; this.holdNamePending = undefined; this.state = "COLLECT_TIME"; return this.advanceBooking(); }
    }

    // Confirming a name we already read back.
    if (this.holdNamePending !== undefined) {
      const pending = this.holdNamePending;
      const spelled = parseSpelledName(text); // a spelled name is high-confidence — take it
      if (spelled) { this.draft.name = spelled; this.holdNamePending = undefined; return this.finaliseHoldNote(); }
      if (/\b(spell|letter by letter)\b/i.test(text)) return Promise.resolve(this.say("Of course — go ahead and spell your first name, letter by letter.", "hold_name"));
      if (isNo(text)) { this.holdNamePending = undefined; return Promise.resolve(this.say("No worries — could you spell your first name for me, letter by letter?", "hold_name")); }
      if (isYes(text)) { this.draft.name = pending; this.holdNamePending = undefined; return this.finaliseHoldNote(); }
      const fresh = parseName(text);
      if (fresh && fresh.toLowerCase() !== pending.toLowerCase()) {
        // A different name offered — read it back once, then accept rather than loop.
        this.nameReasks++;
        if (this.nameReasks >= 2) { this.draft.name = fresh; this.holdNamePending = undefined; return this.finaliseHoldNote(); }
        this.holdNamePending = fresh;
        return Promise.resolve(this.say(`Thanks — ${fresh}. Is that right? Or you can spell it out for me.`, "hold_name"));
      }
      // Unclear — take the pending name rather than loop (it's a call-back note).
      this.draft.name = pending; this.holdNamePending = undefined; return this.finaliseHoldNote();
    }

    // First capture: a spelled name is taken as-is (high-confidence); a SPOKEN name is
    // read back so a mis-hear is catchable before the note is logged (Kevin 2026-10-08).
    const spelledFirst = parseSpelledName(text);
    if (spelledFirst) { this.draft.name = spelledFirst; this.nameReasks = 0; return this.finaliseHoldNote(); }
    const name = parseName(text);
    if (name) {
      this.holdNamePending = name;
      this.nameReasks = 0;
      return Promise.resolve(this.say(`Thanks — I've got that as ${name}. Is that right? If not, just say it again or spell it out for me.`, "hold_name"));
    }
    // Couldn't catch a name — one gentle re-ask, then log under the number anyway.
    this.nameReasks++;
    if (this.nameReasks >= 2) { this.nameReasks = 0; return this.finaliseHoldNote(); }
    return Promise.resolve(this.say("No worries — just your first name is perfect.", "hold_name"));
  }

  /** Leave a real call-back note (name + the number they're on) for the team, then
   * close warmly — honest wording: we're noting it, not reserving a specific table
   * (Kevin 2026-10-07). The owner alert is the actionable record; the recorded call
   * also logs it. */
  private async finaliseHoldNote(): Promise<ReservationTurn> {
    this.state = "END";
    const phone = this.draft.phone ?? this.ctx.callerPhone ?? "unknown";
    // Describe what IS known vs what's still undecided (a day, or a time) so the team's
    // note — and the caller close — is accurate.
    const missing = !this.draft.date ? "day" : "time";
    const known = this.draft.date ? ` for ${speakDate(this.draft.date)}` : "";
    if (this.ctx.ownerAlertNumber) {
      try {
        await enqueueNotification(this.ctx.db, {
          orderId: null,
          kind: "owner_sms",
          toNumber: this.ctx.ownerAlertNumber,
          body: `${this.ctx.restaurantName}: table call-back — ${this.draft.name ?? "a caller"} would like a table${known} but hasn't settled on a ${missing} yet. Ph ${phone}. They'll ring back to confirm.`,
        });
      } catch { /* best-effort — the recorded call still captures the request */ }
    }
    const who = this.draft.name && this.draft.name !== "Guest" ? `, ${this.draft.name}` : "";
    return this.say(
      `Lovely${who} — I've made a note with your number so the team's expecting you. Give us a quick ring back once you've settled on the ${missing} and we'll lock it in. Thanks so much for calling!`,
      "hold_closed",
      true,
    );
  }

  private handleTime(text: string): Promise<ReservationTurn> {
    // A late DATE correction said at the time step ("no sorry, make it Thursday").
    const { acks: corrAcks } = this.applyLateCorrection(text);
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
    // A date correction with no time yet: acknowledge it and ask the time once.
    if (corrAcks.length) {
      return Promise.resolve(this.say(`Of course, I'll ${corrAcks.join(" and ")}. And what time were you thinking of coming in?`, "ask_time"));
    }
    // No time fixed — the caller's vague/undecided about WHEN ("whenever", "not sure
    // of the time", "I'm flexible"), OR we couldn't read a time after one gentle
    // re-ask. We can't lock a slot with no time, so (like a vague DAY) take a first
    // name and leave a real call-back note — never loop the time question (Kevin
    // 2026-10-07 "if no time fixed also do the same procedure").
    if (detectVagueTime(text) || this.timeReasks >= 1) {
      this.timeReasks = 0;
      if (this.draft.name && this.draft.name !== "Guest") return this.finaliseHoldNote();
      this.state = "HOLD_NAME";
      return Promise.resolve(this.say(
        "No problem at all — I can't lock a time in without knowing when, but I'll make a note so the team can look after you. Can I grab your first name?",
        "hold_name",
      ));
    }
    // First reply we couldn't read as a time — one gentle re-ask, then the note path.
    this.timeReasks++;
    return Promise.resolve(this.say("What time were you after?", "ask_time"));
  }

  /**
   * Party size — the highest-risk slot (spec §2-§8, §23). Confident answers pass
   * straight through; an uncertain best guess (STT "for" for "four", a lone
   * number in filler) is CONFIRMED not rejected; "four or five" is disambiguated;
   * and an unparseable answer escalates recovery (reword → keypad → staff
   * call-back) instead of looping the same question.
   */
  private async handleParty(text: string): Promise<ReservationTurn> {
    // Resolve a pending "four or five?" by picking the earlier/later option.
    if (this.ambiguousParty) {
      const [a, b] = this.ambiguousParty;
      const pick =
        /\b(first|former|smaller|lower|fewer|less)\b/i.test(text) ? a :
        /\b(second|latter|bigger|higher|more|larger)\b/i.test(text) ? b :
        null;
      if (pick) { this.ambiguousParty = undefined; return this.acceptParty(pick); }
    }

    // A SUDDEN date/time change stated at the party step ("sorry, make it Sunday",
    // "actually can we do 8pm") must be respected, not ignored (Kevin 2026-10-06:
    // "even sudden date day change respect the customer"). Gated on an EXPLICIT
    // change cue so a normal party answer that merely LOOKS time-ish ("4:00",
    // "about four") is NOT hijacked as a time change — it's just the count.
    const hasChangeCue = /\b(actually|instead|rather|make it|change (?:it|that|the)|changed|scrap|i mean|no wait|different|move it|switch|shift|reschedule|let'?s (?:do|make|change|move)|can we (?:do|make|change|move|have|get|push)|could we)\b/i.test(text);
    if (hasChangeCue) {
      const { acks: corrAcks } = this.applyLateCorrection(text);
      if (corrAcks.length) {
        const p = interpretPartySize(text, { expectingParty: true });
        if (p.kind === "value") {
          this.partyReasks = 0; this.pendingParty = undefined; this.ambiguousParty = undefined;
          this.draft.partySize = p.value;
          const t = await this.advanceBooking();
          return { ...t, say: `No worries, I'll ${corrAcks.join(" and ")}. ${t.say}` };
        }
        this.partyReasks = 0;
        return this.say(`No worries, I'll ${corrAcks.join(" and ")}. And how many will be joining you?`, "ask_party");
      }
    }

    // A stray/duplicated TIME answer ("seven pm", "half past seven") must not be
    // booked as a party of 7 — re-ask the head-count instead of taking the hour.
    if (this.isStrayTime(text)) {
      this.partyReasks++;
      if (this.partyReasks >= 3) return this.beginEscalation();
      return Promise.resolve(this.say(
        this.partyReasks === 1
          ? "And how many will be joining you?"
          : "I didn't catch the number — you can say it, or tap it in on your keypad.",
        this.partyReasks === 1 ? "ask_party" : "ask_party_dtmf",
      ));
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
    // A stray time landing on "N people?" is not a new party size — re-confirm.
    if (this.isStrayTime(text)) {
      this.partyReasks++;
      if (this.partyReasks >= 3) return this.beginEscalation();
      return Promise.resolve(this.say(
        `Just to check — ${numberWord(this.pendingParty ?? 0)} people? You can say yes, or the number.`,
        "confirm_party",
      ));
    }
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
      // Count the re-confirm so a repeated STT homophone ("for"/"four") can't loop
      // "N people?" forever (audit 2026-10-07).
      this.partyReasks++;
      if (this.partyReasks >= 3) return this.beginEscalation();
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
    this.nameTurns = 0;
    this.escalatingConfirm = false;
    if (!this.draft.name) {
      return Promise.resolve(this.say("No worries — I'll get the team to sort it. What name should I put it under?", "escalate_name"));
    }
    if (!this.draft.phone && !this.ctx.callerPhone) {
      return Promise.resolve(this.say("And the best mobile number to reach you on?", "escalate_phone"));
    }
    return this.escalationConfirm();
  }

  private async handleEscalation(text: string): Promise<ReservationTurn> {
    // HARD cap so the call-back name/confirm sub-dialog can never loop (Kevin 2026-10-08).
    if (++this.nameTurns >= 6) { this.escalatingConfirm = false; return this.completeEscalation(); }

    // CONFIRM beat: we've read the details back and asked "have I got that right?".
    // Give the caller a real chance to CORRECT (esp. a mis-heard name) before we close
    // — never recite-and-hang-up in one breath (Kevin 2026-10-08: "confirmed so fast
    // it ended").
    if (this.escalatingConfirm) {
      const spelled = parseSpelledName(text);
      if (spelled) { this.draft.name = spelled; return this.escalationConfirm(); } // spelled correction
      if (/\b(spell|letter by letter)\b/i.test(text)) {
        this.escalatingConfirm = false;
        return Promise.resolve(this.say("Of course — spell your first name for me, letter by letter.", "escalate_name"));
      }
      const { acks } = this.applyLateCorrection(text); // a detail change (date/time/party)
      if (acks.length) return this.escalationConfirm();
      const fresh = parseName(text);
      if (fresh && fresh.toLowerCase() !== (this.draft.name ?? "").toLowerCase()) { this.draft.name = fresh; return this.escalationConfirm(); }
      if (isNo(text) || /\b(wrong|not right|not quite|change)\b/i.test(text)) {
        this.escalatingConfirm = false;
        this.draft.name = undefined;
        return Promise.resolve(this.say("No worries — let's get it right. What name should I put it under?", "escalate_name"));
      }
      return this.completeEscalation(); // "yes" / all good -> finalise + close
    }

    // Collection phase. Honour a correction said in the same breath.
    this.applyLateCorrection(text);
    if (!this.draft.name) {
      const name = parseSpelledName(text) ?? parseName(text);
      if (name) this.draft.name = name;
      else if (++this.nameReasks >= 3) this.draft.name = "Guest";
      else return Promise.resolve(this.say("No worries — what name should I put it under?", "escalate_name"));
    }
    if (this.draft.name && !this.draft.phone && !this.ctx.callerPhone) {
      const phone = parsePhone(text);
      if (phone) this.draft.phone = phone;
      else if (++this.phoneReasks < 2) return Promise.resolve(this.say("What's the best mobile number, digit by digit?", "escalate_phone"));
    }
    return this.escalationConfirm();
  }

  /** Read the call-back details + name back and PAUSE for confirmation — not an
   * instant hang-up. The caller can correct the name (spell it) or a detail first. */
  private escalationConfirm(): Promise<ReservationTurn> {
    this.escalatingConfirm = true;
    this.state = "ESCALATION";
    const parts: string[] = [];
    if (this.draft.partySize !== undefined) parts.push(`a group of ${this.draft.partySize}`);
    if (this.draft.date) parts.push(this.draft.time ? `on ${speakDate(this.draft.date)} at ${speakTime(this.draft.time)}` : `on ${speakDate(this.draft.date)}`);
    const who = this.draft.name && this.draft.name !== "Guest" ? ` under ${this.draft.name}` : "";
    const summary = parts.length ? `${parts.join(" ")}${who}` : "your details";
    return Promise.resolve(this.say(
      `Let me just check I've got this right — ${summary}. Is that right? If the name's not quite right, you can spell it for me.`,
      "escalate_confirm",
    ));
  }

  private async completeEscalation(): Promise<ReservationTurn> {
    this.state = "END";
    this.escalatingConfirm = false;
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
    // The details were just read back at the confirm beat — a warm, brief close now
    // (not another full recital, Kevin 2026-10-05: don't talk at the caller).
    const who = this.draft.name && this.draft.name !== "Guest" ? `, ${this.draft.name}` : "";
    return this.say(
      `Lovely${who} — that's all noted and I'll pass your number to the team. They'll confirm it and call you right back. Thanks so much for calling!`,
      "escalated",
      true,
    );
  }

  private async runAvailability(): Promise<ReservationTurn> {
    const { date, time, partySize } = this.draft;
    let result: Awaited<ReturnType<typeof checkAvailability>>;
    try {
      result = await checkAvailability({
        db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
        settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
        date: date!, time: time!, partySize: partySize!,
      });
    } catch {
      // A transient DB/availability error must never drop a connected caller — hand
      // off to a staff call-back rather than crash the turn (fail-safe, spec §31).
      return this.beginEscalation();
    }
    switch (result.status) {
      case "AVAILABLE":
        return this.collectContact();
      case "PARTY_TOO_LARGE": {
        this.state = "ESCALATION";
        this.nameTurns = 0;
        this.escalatingConfirm = false;
        // Read the booking back so the caller hears it's understood (Kevin 2026-10-07:
        // a big group escalated with no confirmation of the date/day/time felt abrupt).
        const when = date && time ? ` on ${speakDate(date)} at ${speakTime(time)}` : "";
        return this.say(
          `Lovely — a group of ${partySize}${when}. For a party that size I'll get the team to confirm it and call you straight back. Can I grab your name?`,
          "escalate_party",
        );
      }
      case "CLOSED": {
        this.state = "COLLECT_TIME";
        this.draft.time = undefined;
        // State the actual opening window so the caller isn't left guessing times
        // before we open and looping on "we're not open then" (live India inbound
        // 2026-10-05: caller tried 3pm/4pm repeatedly, never told we open at 5pm).
        const hrs = this.hoursForDate(this.draft.date);
        if (hrs) {
          const open = speakTime(hrs.opensAt);
          const close = speakTime(hrs.closesAt);
          return this.say(
            `We're open from ${open} till ${close} that day — what time from ${open} onwards suits you?`,
            "ask_time",
          );
        }
        return this.say("I'm afraid we're closed that day — would another day suit you?", "ask_time");
      }
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
      this.altReasks = 0;
      this.draft.time = picked;
      return this.runAvailability();
    }
    if (isNo(text)) {
      this.altReasks = 0;
      this.state = "COLLECT_TIME";
      this.draft.time = undefined;
      return Promise.resolve(this.say("No worries — what time would you prefer?", "ask_time"));
    }
    // Unclear reply — re-offer once, then bow out to a call-back rather than loop the
    // same two times forever (audit 2026-10-07: OFFER_ALTERNATIVES had no bound).
    this.altReasks++;
    if (this.altReasks >= 2) { this.altReasks = 0; return this.beginEscalation(); }
    return Promise.resolve(this.say(`Would you like ${this.altTimes.slice(0, 2).map(speakTime).join(" or ")}?`, "alternatives"));
  }

  private collectContact(): Promise<ReservationTurn> {
    if (!this.draft.name) {
      this.state = "COLLECT_NAME";
      // Restate the whole booking before taking the name (reference-style), so a
      // mis-heard detail is caught here and the caller feels looked-after.
      const when = this.draft.date && this.draft.time && this.draft.partySize !== undefined
        ? speakWhen(this.draft.date, this.draft.time, this.ctx.now(), this.ctx.timezone)
        : null;
      const restate = when
        ? this.pick([
            `Lovely — so that's a table for ${numberWord(this.draft.partySize!)} ${when}. That time's free — may I grab a name for the booking?`,
            `Wonderful — a table for ${numberWord(this.draft.partySize!)} ${when}, and that time's free. Can I grab a name for the booking?`,
            `Perfect — ${numberWord(this.draft.partySize!)} ${when}, that's available. And whose name shall I put it under?`,
          ])
        : `${this.ack()} — that time's free. May I grab a name for the booking?`;
      return Promise.resolve(this.say(restate, "ask_name"));
    }
    if (!this.draft.phone) {
      // Caller ID known: confirm using the number they're calling from, rather
      // than silently taking it or making them recite it (Kevin: "if it's the same
      // number I'm calling from, accept it from there" — reference-style).
      if (this.ctx.callerPhone && !this.phoneConfirmed) {
        this.phoneConfirmed = true;
        this.state = "CONFIRM_PHONE";
        return Promise.resolve(this.say(this.pick([
          "And is the number you're calling from the best one for the booking?",
          "Shall I use the number you're calling from, or is there a better one?",
          "And is the mobile you're calling from the best way to reach you?",
        ]), "confirm_phone"));
      }
      // No caller ID — ask for a number.
      if (!this.ctx.callerPhone) {
        this.state = "COLLECT_PHONE";
        return Promise.resolve(this.say(this.pick(["Wonderful. And the best number to reach you on?", "Lovely. And the best number to reach you on?", "Great — and what's the best number to reach you on?"]), "ask_phone"));
      }
    }
    // NO proactive "special touches" question — Kevin 2026-10-07: "no need [for those]
    // questions, make sure it never lags." We go straight to confirm to keep the call
    // short. A preference the caller VOLUNTEERS ("a window seat please", "no nuts") is
    // still captured passively by captureExtras in next() — we just never ask for one.
    return this.askToConfirmBooking();
  }

  /** The special-touches answer. Any occasion / seating / dietary note was already
   * captured by captureExtras in next(); here we move on to confirming (a plain
   * "no"/"nothing" just proceeds — we never loop on this nicety). */
  private async handleExtras(text: string): Promise<ReservationTurn> {
    // Let the caller bail here too ("no, don't book it") — never book on a cancel.
    if (detectIntent(text) === "cancel" || /\b(cancel|don'?t book|do not book|forget it|never mind|changed my mind)\b/i.test(text)) {
      this.state = "END";
      return Promise.resolve(this.say("No worries — I won't lock anything in. Give us a call back anytime. Cheers!", "booking_abandoned", true));
    }
    // A change stated during the preference questions ("actually make it 8pm",
    // "change it to Saturday", "make it six") must be rectified, then we flow back
    // to where we were (Kevin 2026-10-06: "if any changes made in between, make sure
    // it's rectified and move to the question asked"). Gated on an explicit change
    // cue so a plain preference answer isn't mistaken for a correction.
    if (/\b(actually|instead|rather|make it|change (?:it|that|the)|changed|move it|switch|shift|reschedule|let'?s (?:do|make|change|move)|can we (?:do|make|change|move|have|get|push)|could we)\b/i.test(text)) {
      const { acks } = this.applyLateCorrection(text);
      if (acks.length) {
        // Re-validate the (possibly new) date/time/party, then resume the extras flow.
        const t = await this.runAvailability();
        return { ...t, say: `No worries, I'll ${acks.join(" and ")}. ${t.say}` };
      }
    }
    // A global "no thanks / nothing / that's all" skips the REMAINING preference
    // questions so we don't pester. A BARE "no" is NOT global — it just answers this
    // one question ("no, not a special occasion") and moves to the next. Kevin
    // 2026-10-05: ask each separately, but don't nag.
    if (
      /\b(no thanks|no thank you|nothing(?: else)?|none|no preferences?|that'?s (?:all|it|everything|fine)|that is all|we'?re (?:all )?(?:good|fine|set|right|sorted)|all good|just the (?:table|booking)|no that'?s it|that'?s everything)\b/i.test(text)
    ) {
      this.askedOccasion = true;
      this.askedSeating = true;
      this.askedDietary = true;
    }
    return this.collectContact();
  }

  /** CONFIRM_PHONE: the caller confirms the number they're calling from, or gives a
   * different one. Any clear number wins; "yes" uses the caller ID; "no" asks for
   * a number; unclear re-asks once then falls back to the caller ID. */
  private async handleConfirmPhone(text: string): Promise<ReservationTurn> {
    // A date/time/party CHANGE stated at the phone step ("actually, make it Tuesday
    // in two weeks") — apply it and re-confirm; don't mistake the "no" for "a
    // different number" (live AU call 2026-10-06). Re-validates the new slot.
    const { acks } = this.applyLateCorrection(text);
    if (acks.length) {
      this.phoneReasks = 0;
      const t = await this.runAvailability();
      return { ...t, say: `No worries, I'll ${acks.join(" and ")}. ${t.say}` };
    }
    const phone = parsePhone(text);
    if (phone) { this.draft.phone = phone; this.phoneReasks = 0; return this.collectContact(); }
    // "yes" OR "the same number / the one I'm calling from" -> use the caller ID.
    if ((isYes(text) || this.saysSameNumber(text)) && this.ctx.callerPhone) {
      this.draft.phone = this.ctx.callerPhone; this.phoneReasks = 0; return this.collectContact();
    }
    if (isNo(text)) {
      this.state = "COLLECT_PHONE";
      return this.say("No worries — what's the best number to reach you on, then?", "ask_phone");
    }
    this.phoneReasks++;
    if (this.phoneReasks >= 2) { this.draft.phone = this.ctx.callerPhone!; this.phoneReasks = 0; return this.collectContact(); }
    return this.say("No worries — shall I use the number you're calling from? Just say yes, or give me the number.", "confirm_phone");
  }

  /** The caller means "use the number I'm calling from" ("same number", "this one",
   * "the one I'm calling from") — accept the caller ID rather than asking for digits
   * (live AU call 2026-10-06: "the same number" looped the number request). */
  private saysSameNumber(text: string): boolean {
    return /\b(same (?:number|one|mobile|phone)|this (?:number|one|mobile|phone)|the one i'?m (?:calling|ringing)|(?:number|phone) i'?m (?:calling|ringing)|calling from|ringing from|this is the one)\b/i.test(text);
  }

  /** Read the full booking back and ask the caller to confirm (or change / cancel)
   * BEFORE it's created — a clear spoken confirm/cancel moment with an unhurried
   * gap, rather than auto-booking and rushing to hang up (Kevin: "no gap for the
   * customer to say confirmed or cancelling"). The booking is created only on a
   * clear yes. */
  private askToConfirmBooking(): Promise<ReservationTurn> {
    this.state = "CONFIRM_DETAILS";
    const who = this.draft.name && this.draft.name !== "Guest" ? `, ${this.draft.name}` : "";
    // Don't re-recite the whole booking here — the day, date, time and name were each
    // confirmed out loud as we collected them, so a final full read-back just feels
    // repetitive (Kevin 2026-10-05: "only repeat if they ask; otherwise just ask them
    // to confirm"). A caller can say "repeat that" any time for the full read-back.
    // Offer an "anything else" beat before locking so the caller feels looked-after,
    // not hurried (Kevin 2026-10-07: "urge to finish fast without considering the
    // customer"). Still a clear yes/change/cancel moment.
    return Promise.resolve(this.say(this.pick([
      `All set${who} — is there anything else you'd like, or shall I lock that in?`,
      `Lovely${who} — anything else I can help with, or shall I lock it in for you?`,
      `Perfect${who} — anything else before I lock it in, or are we good to go?`,
    ]), "confirm_booking"));
  }

  /** At the confirm beat, a caller DECLINING to add anything — "no thanks", "no,
   * that's it", "nothing else", "no occasion", "no allergies", "we're good" — is
   * answering the "anything else you'd like?" half of the compound lock-in question.
   * They mean "nothing more to add", i.e. go ahead — NOT "I want to change the
   * booking". Kept distinct from a bare ambiguous "no" and from an explicit change
   * request (both handled separately). An outright cancel is caught earlier. */
  private isDeclineToAdd(text: string): boolean {
    return /\b(that'?s (?:it|all|everything|the lot)|nothing (?:else|more|further|special)|no (?:nothing|thanks?|thank you|occasion|allerg\w+|dietary|diet|preferences?|requests?|special|other)|not (?:really|fussed|that i can think of)|we'?re (?:good|fine|set|done|right|sorted)|i'?m (?:good|fine|done|set|sorted)|no i'?m (?:good|fine|ok|okay)|all (?:done|sorted))\b/i.test(text);
  }

  /** Read captured notes back warmly (reference-style "I've noted…"), or "" when
   * there are none. "window seat; no shrimp" -> " I've noted a window seat, and no shrimp." */
  private notesPhrase(notes?: string): string {
    const n = (notes ?? "").trim();
    if (!n) return "";
    return ` I've noted ${n.replace(/;\s*/g, ", and ")}.`;
  }

  /** The confirm beat (CONFIRM_DETAILS): create ONLY on a clear yes; honour a
   * direct change ("no, make it six" / "actually 8pm"); let a plain "no" open a
   * change; cancel outright never books. */
  private async handleConfirmBooking(text: string): Promise<ReservationTurn> {
    // A change naming TWO distinct days ("change the day to Sunday or Monday") — never
    // silently pick one; clarify which, then re-check availability and re-confirm
    // (Kevin 2026-10-07). A single clear day falls through to applyLateCorrection.
    const two = this.twoDateOptions(text);
    if (two) return this.clarifyTwoDates(two, "CONFIRM_DETAILS");
    // A direct change stated at the confirm step — adjust, re-check availability,
    // and re-read before booking.
    const { acks: corrAcks } = this.applyLateCorrection(text);
    if (corrAcks.length) {
      this.confirmReasks = 0;
      const t = await this.runAvailability();
      return { ...t, say: `No worries, I'll ${corrAcks.join(" and ")}. ${t.say}` };
    }
    // A relative week shift with no weekday ("actually, the following week") — move
    // the existing date by whole weeks (Kevin 2026-10-05: don't make them fight it).
    const wkShiftC = detectWeekShift(text);
    if (wkShiftC !== 0 && this.draft.date) {
      this.draft.date = shiftDate(this.draft.date, wkShiftC);
      this.confirmReasks = 0;
      const t = await this.runAvailability();
      return { ...t, say: `No worries, I'll move it to ${speakDate(this.draft.date)}. ${t.say}` };
    }
    // A NAME correction stated at the confirm step ("no, the name's Raju", "it's
    // under Raju", "my name is Raju") — the real-time STT often mis-hears a name,
    // so let the caller fix it here instead of booking the wrong one (Kevin's live
    // call: "Raju" booked as "Got").
    if (/\b(name|under|call me|spel|spelt|spelled|first name)\b/i.test(text)) {
      const nm = parseName(text);
      if (nm && nm.toLowerCase() !== (this.draft.name ?? "").toLowerCase()) {
        this.draft.name = nm; this.confirmReasks = 0;
        const t = await this.askToConfirmBooking();
        return { ...t, say: `No worries, under ${nm}. ${t.say}` };
      }
    }
    // Cancel outright — never create a booking.
    if (detectIntent(text) === "cancel" || /\b(cancel|don'?t book|do not book|scrap it|forget it|never mind|changed my mind|not anymore)\b/i.test(text)) {
      this.state = "END";
      return this.say("No worries — I won't lock anything in. Give us a call back anytime and we'll sort your table. Cheers!", "booking_abandoned", true);
    }
    // Clear yes — or the caller literally saying "confirm" / "lock it in" / "go
    // ahead" — create it now. (Kevin: make sure a "confirm" locks it in.)
    if (isYes(text) || /\b(confirm(ed)?|lock (?:it|that) in|go ahead|that'?s (?:right|confirmed)|all good|all set)\b/i.test(text)) {
      return this.finaliseBooking();
    }
    // The confirm beat asks a COMPOUND question ("anything else you'd like, OR shall
    // I lock it in?"). A caller who DECLINES to add anything — "no thanks", "no,
    // that's it", "nothing else", "no occasion", "no allergies", "nothing special" —
    // is answering the "anything else?" half: nothing more to add, so lock it in.
    // This matches the reference exactly ("Anything else before I confirm?" -> "No,
    // that's it." -> confirmed). MUST be checked before the plain-"no" branch below,
    // since these phrases contain "no". (Bug 2026-10-07: "no allergies thanks" /
    // "no occasion" / "nothing special" were mis-routed to "what would you like to
    // change?" — a confusing non-sequitur when the caller clearly wanted to proceed.)
    if (this.isDeclineToAdd(text)) {
      return this.finaliseBooking();
    }
    // A plain, bare "no" with no specific change — the caller is rejecting, not
    // declining extras, so open the change menu.
    if (isNo(text)) {
      this.state = "CONFIRM_BOOKING_CHANGE";
      return this.say("No worries — what would you like to change? The day, the time, the number, or the name?", "confirm_change");
    }
    // Unclear — ask once more, then go ahead rather than strand a complete booking.
    this.confirmReasks++;
    if (this.confirmReasks >= 2) return this.finaliseBooking();
    return this.say("Shall I go ahead and lock that in for you?", "confirm_booking");
  }

  /** After a plain "no" at the confirm beat: apply the change the caller names
   * (bare values are fine here — they were asked what to change), re-validate, and
   * re-read for confirmation. */
  private async handleConfirmBookingChange(text: string): Promise<ReservationTurn> {
    if (detectIntent(text) === "cancel" || /\b(cancel|don'?t book|forget it|never mind|changed my mind)\b/i.test(text)) {
      this.state = "END";
      return Promise.resolve(this.say("No worries — I won't lock anything in. Call us back anytime. Cheers!", "booking_abandoned", true));
    }
    // "confirm" / "no changes" / "leave it as is" / "no thanks" / "nothing else" at
    // the change step means BOOK it, not rename it to "Confirm" (live India call
    // 2026-10-05 booked the name "Confirm" from "no, confirm") and not loop back on
    // "what would you like to change?". Lock it in rather than treating it as a change.
    if (isYes(text) || this.isDeclineToAdd(text) || /\b(confirm(ed)?|lock (?:it|that) in|go ahead|leave it|keep it|as is|no changes?|that'?s (?:fine|right|correct|all|it|perfect))\b/i.test(text)) {
      return this.finaliseBooking();
    }
    // Two days named here too ("Sunday or Monday") — clarify which, don't pick one.
    const twoC = this.twoDateOptions(text);
    if (twoC) return this.clarifyTwoDates(twoC, "CONFIRM_DETAILS");
    // A relative week shift ("the following week", "a week later", "two weeks
    // earlier") nudges the EXISTING date by whole weeks without the caller restating
    // it (Kevin 2026-10-05: a caller shouldn't have to fight to move it a week).
    const wkShift = detectWeekShift(text);
    if (wkShift !== 0 && this.draft.date) {
      this.draft.date = shiftDate(this.draft.date, wkShift);
      this.confirmReasks = 0;
      return this.runAvailability();
    }
    // Track what changed so we can confirm it back briefly (feedback the caller asked
    // for), rather than re-reciting the whole booking (Kevin 2026-10-05).
    const acks: string[] = [];
    if (this.hasDateWord(text)) {
      const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
      if (d.date && d.date !== this.draft.date) { this.draft.date = d.date; acks.push(`change it to ${speakDate(d.date)}`); }
    }
    if (this.hasTimeCue(text)) {
      const r = normaliseTime(text);
      if (r.time && r.time !== this.draft.time) { this.draft.time = r.time; acks.push(`move it to ${speakTime(r.time)}`); }
    } else {
      const p = interpretPartySize(text, { expectingParty: true });
      if (p.kind === "value" && p.value !== this.draft.partySize) { this.draft.partySize = p.value; acks.push(`make it ${numberWord(p.value)}`); }
    }
    // A name change ("the name's Raju" / "put it under Raju" / just "Raju") — they
    // were asked what to change, so a bare name is a name change here.
    if (acks.length === 0) {
      const nm = parseName(text);
      if (nm && nm.toLowerCase() !== (this.draft.name ?? "").toLowerCase()) { this.draft.name = nm; acks.push(`put it under ${nm}`); }
    }
    if (acks.length === 0) {
      this.confirmReasks++;
      if (this.confirmReasks >= 3) return this.askToConfirmBooking();
      return this.say("Sure — what would you like to change: the day, the time, the number, or the name?", "confirm_change");
    }
    this.confirmReasks = 0;
    const t = await this.runAvailability(); // re-validate the new slot, then re-confirm
    return { ...t, say: `No worries, I'll ${acks.join(" and ")}. ${t.say}` };
  }

  private async handleName(text: string): Promise<ReservationTurn> {
    // "Why do you need my name?" — reassure briefly, don't treat the question as a
    // name or count it as a failed attempt (curveball survey 2026-10-06).
    if (/\bwhy\b[^?]*\bname\b|what(?:'?s)?\b[^?]*\bname\b[^?]*\bfor\b|why do you (?:need|want)\b/i.test(text)) {
      return this.say(
        "Just so the restaurant knows who the table's for — a first name's all I need.",
        "ask_name",
      );
    }
    // A late correction to party/date/time said at the name step
    // ("actually make it six, name's Tara") must be honoured, not dropped — and
    // the name must still parse from the remainder (cleaned) of the same breath.
    const { acks: corrAcks, cleaned } = this.applyLateCorrection(text);
    let name = parseName(cleaned);
    if (!name) {
      // A name bundled with a request ("it's Kevin, and a table by the window") can
      // leave residue ("...a table") that defeats the strict parse — salvage a
      // RECOGNISED first name from the words. Dictionary-gated, so it can never
      // invent a name from request words (Kevin 2026-10-05).
      const tok = cleaned
        .toLowerCase()
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .find((w) => COMMON_NAMES.has(w));
      if (tok) name = tok.charAt(0).toUpperCase() + tok.slice(1);
    }
    // If the caller spelled it out ("Angel, A-N-G-E-L"), use the spelled version —
    // otherwise the loose letters get appended to the name and we book "Angel
    // A-n-g-e-l" (live India call 2026-10-05).
    const singleLetters = cleaned.replace(/[^a-zA-Z]+/g, " ").trim().split(/\s+/).filter((w) => w.length === 1);
    let fromSpelling = false;
    if (singleLetters.length >= 3) {
      const spelled = parseSpelledName(cleaned);
      if (spelled) { name = spelled; fromSpelling = true; }
    }
    if (!name) {
      if (corrAcks.length) {
        // This turn was a correction, not a failed name attempt — don't count it.
        return this.say(`No worries, I'll ${corrAcks.join(" and ")}. And what name should I put the table under?`, "ask_name");
      }
      this.nameReasks++;
      // GENTLE, respectful recovery — never badger (Kevin 2026-10-06: "AI rudely
      // keeps asking name without any respect"). 1st: warm re-ask, blame the line.
      // 2nd: offer to spell it (move to SPELL_NAME). After that: don't keep asking —
      // take the booking under their number and let the team add the name on arrival.
      if (this.nameReasks === 1) {
        return this.say("Sorry, the line dipped a little there — just your first name's perfect, whenever you're ready.", "ask_name");
      }
      if (this.nameReasks === 2) {
        this.state = "SPELL_NAME";
        return this.say("No rush at all — the line's being a bit unkind to me. Could you spell your first name for me, letter by letter?", "spell_name");
      }
      return this.proceedWithoutName();
    }
    // A doubtful name (not a recognised common name, or too short) is read back
    // for confirmation, with an offer to spell it — so a mis-hear is caught before
    // it's booked (Kevin: "if the name is misheard, confirm it or ask them to
    // spell it"). Common names pass straight through so most calls aren't slowed.
    // A name the caller SPELLED OUT is already explicit — accept it straight away,
    // never read the letters back or ask them to spell it again (Kevin 2026-10-05:
    // "reading the spelling unnecessarily").
    if (!fromSpelling && this.isNameDoubtful(name)) {
      this.pendingName = name;
      this.nameReasks = 0;
      this.state = "CONFIRM_NAME";
      const ack = corrAcks.length ? `No worries, I'll ${corrAcks.join(" and ")}. ` : "";
      return this.say(`${ack}Thanks — I've got that as ${name}. Did I hear that right? If not, you can spell it out for me.`, "confirm_name");
    }
    this.draft.name = name;
    const turn = await this.collectContact();
    if (corrAcks.length) return { ...turn, say: `No worries, I'll ${corrAcks.join(" and ")}. ${turn.say}` };
    return turn;
  }

  /** A name we're unsure of: not a recognised common first name, or too short to
   * trust from a phone STT. Such names get a quick read-back + spell offer. */
  private isNameDoubtful(name: string): boolean {
    const first = name.toLowerCase().split(/\s+/)[0] ?? "";
    if (first.replace(/[^a-z]/g, "").length <= 2) return true;
    return !COMMON_NAMES.has(first);
  }

  /** CONFIRM_NAME: the caller confirms the read-back name, spells it, corrects it,
   * or asks to spell — never loops (accepts the heard name after a couple of tries). */
  private handleConfirmName(text: string): Promise<ReservationTurn> {
    // HARD cap on the whole name sub-dialog (Kevin 2026-10-08: "without any sort of
    // looping"). Once hit, take the best name we have and move on — never cycle.
    if (++this.nameTurns >= 5) {
      const best = parseSpelledName(text) ?? parseName(text) ?? this.pendingName;
      return best ? this.acceptName(best) : this.proceedWithoutName();
    }
    const spelled = parseSpelledName(text);
    if (spelled) return this.acceptName(spelled); // a spelled reply is definitive
    if (/\b(spell|letter by letter|i'?ll spell|spell it)\b/i.test(text)) {
      this.state = "SPELL_NAME";
      return Promise.resolve(this.say("Of course — go ahead and spell your first name, letter by letter.", "spell_name"));
    }
    if (isYes(text)) return this.acceptName(this.pendingName!);
    // A fresh name offered instead ("no, it's Dave" / "it's Priya").
    const fresh = parseName(text);
    if (fresh && fresh.toLowerCase() !== (this.pendingName ?? "").toLowerCase()) {
      if (this.isNameDoubtful(fresh)) {
        this.pendingName = fresh;
        return Promise.resolve(this.say(`Thanks — ${fresh}. Is that right, or would you like to spell it for me?`, "confirm_name"));
      }
      return this.acceptName(fresh);
    }
    // "No" / "say it again / say it slowly / that's wrong" — it was misheard: let them
    // say it PROPERLY (slowly) OR spell it. Bounded by nameTurns above, so no loop.
    if (isNo(text) || /\b(say (it|that|my name)|said|slow(ly)?|again|pronounce|not quite|wrong)\b/i.test(text)) {
      this.state = "COLLECT_NAME";
      this.pendingName = undefined;
      return Promise.resolve(this.say("No worries — say your first name slowly for me, or spell it out letter by letter.", "ask_name"));
    }
    return Promise.resolve(this.say(`Sorry — did I get that as ${this.pendingName}? You can say yes, spell it, or say it slowly.`, "confirm_name"));
  }

  /** SPELL_NAME: build the name from the letters, then READ THE ASSEMBLED NAME BACK
   * to confirm the spelling landed (Kevin 2026-10-08 "ask to spell and read together")
   * — not silently accepted. Hard-capped by nameTurns so it can never loop. */
  private handleSpellName(text: string): Promise<ReservationTurn> {
    if (++this.nameTurns >= 5) {
      const best = parseSpelledName(text) ?? parseName(text) ?? this.pendingName;
      return best ? this.acceptName(best) : this.proceedWithoutName();
    }
    const spelled = parseSpelledName(text);
    if (spelled) {
      this.pendingName = spelled;
      this.state = "CONFIRM_NAME";
      return Promise.resolve(this.say(`Thanks — so that's ${spelled}. Have I got that right? Just say yes, or say it again.`, "confirm_name"));
    }
    // The caller may just SAY their name instead of spelling it ("Susan") — read it
    // back to confirm (live India call 2026-10-07: "Susan" at the spell step dropped).
    const spoken = parseName(text);
    if (spoken) {
      this.pendingName = spoken;
      this.state = "CONFIRM_NAME";
      return Promise.resolve(this.say(`So that's ${spoken} — have I got that right? Or spell it out for me.`, "confirm_name"));
    }
    if (this.pendingName) return this.acceptName(this.pendingName);
    // NOTHING parseable (just noise) — don't badger: one gentle spell prompt, then
    // after a couple of empty attempts take the booking under their number (Kevin
    // 2026-10-06). (nameReasks counts the unparseable attempts; nameTurns is the
    // overall cap above.)
    this.nameReasks++;
    if (this.nameReasks >= 2) return this.proceedWithoutName();
    return Promise.resolve(this.say("No worries — just the letters one at a time, like \"J, O, H, N\", whenever you're ready.", "spell_name"));
  }

  /** The line's too rough to catch a name — stop asking and carry on, taking the
   * booking under the caller's number so the team can add the name on arrival. A
   * respectful exit rather than badgering or dead-ending (Kevin 2026-10-06). Only
   * when we actually have a number to book against. */
  private proceedWithoutName(): Promise<ReservationTurn> {
    if (!this.draft.phone && !this.ctx.callerPhone) return this.beginEscalation();
    this.nameReasks = 0;
    this.nameTurns = 0;
    this.pendingName = undefined;
    this.draft.name = "Guest";
    return this.collectContact().then((t) => ({
      ...t,
      say: `No trouble at all — I'll pop it under the number you're calling from, and the team can add your name when you arrive. ${t.say}`,
    }));
  }

  /** Store the confirmed/spelled name and carry on with the booking. */
  private acceptName(name: string): Promise<ReservationTurn> {
    this.draft.name = name;
    this.pendingName = undefined;
    this.nameReasks = 0;
    this.nameTurns = 0;
    return this.collectContact();
  }

  private handlePhone(text: string): Promise<ReservationTurn> {
    // A late correction to party/date/time said at the phone step is honoured.
    const { acks: corrAcks } = this.applyLateCorrection(text);
    const phone = parsePhone(text);
    if (!phone) {
      // "the same number I'm calling from" -> use the caller ID (don't keep asking
      // for digits — live AU call 2026-10-06 looped here and escalated).
      if (this.saysSameNumber(text) && this.ctx.callerPhone) {
        this.draft.phone = this.ctx.callerPhone; this.phoneReasks = 0; return this.collectContact();
      }
      if (corrAcks.length) {
        return Promise.resolve(this.say(`Of course, I'll ${corrAcks.join(" and ")}. And the best number to reach you on?`, "ask_phone"));
      }
      this.phoneReasks++;
      if (this.phoneReasks >= 3) {
        // Caller won't give a number but we HAVE their caller ID — just use it and
        // finish the booking (proper confirmed ending) rather than dead-ending in a
        // call-back (Kevin 2026-10-06). Only escalate when there's truly no number.
        if (this.ctx.callerPhone) { this.draft.phone = this.ctx.callerPhone; this.phoneReasks = 0; return this.collectContact(); }
        return this.beginEscalation();
      }
      return Promise.resolve(this.say(
        this.phoneReasks === 1
          ? "No worries — could I grab that mobile number once more?"
          : "You can say the mobile digit by digit, or tap it in on your keypad.",
        this.phoneReasks === 1 ? "ask_phone" : "ask_phone_dtmf",
      ));
    }
    this.draft.phone = phone;
    return this.collectContact();
  }

  private async finaliseBooking(): Promise<ReservationTurn> {
    const phone = this.draft.phone ?? this.ctx.callerPhone!;
    const { date, time, partySize, name } = this.draft;
    // Idempotency key so a retried/duplicated finalise can't double-book (§8).
    const idempotencyKey = `${this.ctx.callId ?? phone}:${date}:${time}:${partySize}`;
    const input = {
      restaurantId: this.ctx.restaurantId, customerName: name!, customerPhone: phone,
      date: date!, time: time!, partySize: partySize!, source: this.ctx.source ?? "phone",
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
        let avail: Awaited<ReturnType<typeof checkAvailability>>;
        try {
          avail = await checkAvailability({
            db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
            settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
            date: date!, time: time!, partySize: partySize!,
          });
        } catch {
          this.draft.time = undefined;
          this.state = "COLLECT_TIME";
          return this.say("Ah, that spot's just gone, I'm afraid — what other time would suit?", "capacity_gone");
        }
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
        return this.say("Ah, that spot's just gone, I'm afraid — what other time would suit?", "capacity_gone");
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
    // Keep this short: the caller just heard the full read-back at the lock step and
    // the SMS carries the details — re-reciting it all here felt like a monologue
    // with no room to speak (Kevin 2026-10-05). A brief, warm confirmation instead.
    const addr = r.customerName && r.customerName !== "Guest" ? `, ${r.customerName}` : "";
    return this.say(
      `Lovely${addr} — you're all booked in, and I'll send you a quick text to confirm. Is there anything else I can help you with?`,
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
      let cancelled = false;
      try {
        cancelled = Boolean(await cancelReservation(this.ctx.db, this.reservation.id));
      } catch {
        this.state = "END";
        return this.say("No problem — I'll make sure the team cancels that for you. Thanks for calling.", "cancelled_same_call", true);
      }
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
    // A DIRECT change stated against the booking ("make it six, not four" / "can
    // we do 8pm instead") is applied straight away — don't ignore it or make the
    // caller re-state it. (§ honour corrections, even after confirmation.)
    if (this.reservation) {
      const changes = this.extractReservationChange(text);
      if (changes.date || changes.time || changes.partySize !== undefined) {
        let result: Awaited<ReturnType<typeof modifyReservation>>;
        try {
          result = await modifyReservation(this.ctx.db, {
            reservationId: this.reservation.id, changes,
            hours: this.ctx.hours, settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
          });
        } catch {
          // The booking already stands; a failed change just keeps the original.
          return this.say("I couldn't change that just now, so I've kept your booking as it was. Anything else?", "modify_failed");
        }
        if ("reservation" in result) {
          this.reservation = result.reservation;
          const r = result.reservation;
          return this.say(
            `No worries — that's now for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}. Anything else, or are you all set?`,
            "modified",
          );
        }
        if ("unavailable" in result) {
          const alts = result.unavailable.alternatives.slice(0, 2).map(speakTime);
          return this.say(
            alts.length ? `That's not available, but I've got ${alts.join(" or ")}. Would either work?` : "That's not available, I'm afraid — is there another time that'd suit?",
            "modify_unavailable",
          );
        }
      }
    }
    if (intent === "modify" && this.reservation) {
      this.candidates = [this.reservation];
      this.pendingAction = "modify";
      this.state = "MODIFY_WHAT";
      return this.say("Sure — what would you like to change?", "modify_what");
    }
    // Ending: ring off on a clear "done" OR a plain acknowledgement. After "anything
    // else?", "okay / thanks / great / lovely / that's all" all mean the caller is
    // finished — close warmly, don't loop "was there anything else?" at them (Kevin
    // 2026-10-05: "don't loop sentences unnecessarily at the end"). Only a genuinely
    // UNCLEAR reply (not an ack) gets the single gentle re-offer below.
    const ackDone =
      /\b(okay|ok|alright|all right|cool|great|perfect|lovely|brilliant|wonderful|fantastic|excellent|thanks?|thank you|cheers|ta|good|fine|nope|nah|sounds good|we'?re (?:good|fine|set|done|right)|all (?:good|done|set)|that'?ll be all|that'?s (?:great|good|fine|it|all|lovely|everything|perfect))\b/i.test(text);
    if (detectDone(text) || isNo(text) || ackDone) {
      this.state = "END";
      return this.say(this.warmGoodbye(), "goodbye", true);
    }
    this.postConfirmReprompts += 1;
    if (this.postConfirmReprompts >= 2) {
      this.state = "END";
      return this.say(this.warmGoodbye(), "goodbye", true);
    }
    return this.say("Of course — was there anything else I can help you with?", "anything_else");
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
    try {
      this.candidates = await findReservations(this.ctx.db, this.ctx.restaurantId, this.ctx.callerPhone);
    } catch {
      return this.beginEscalation(); // DB hiccup — hand off rather than drop the call
    }
    if (this.candidates.length === 0) {
      // Offer to make one — go to GREETING (not END) so a "yes" actually starts a
      // booking instead of dead-ending into a generic reprompt (audit 2026-10-07).
      this.state = "GREETING";
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
      let cancelled = false;
      try {
        cancelled = Boolean(await cancelReservation(this.ctx.db, this.candidates[0]!.id));
      } catch {
        this.state = "END";
        return this.say("I'm having a little trouble cancelling that right now — please give us a quick call back and we'll sort it. Cheers!", "cancel_failed", true);
      }
      this.cancelReasks = 0;
      this.state = "END";
      return this.say(cancelled ? "Done, that's cancelled. You'll get a text to confirm." : "That booking's already cancelled.", "cancelled", true);
    }
    if (isNo(text)) {
      this.cancelReasks = 0;
      this.state = "END";
      return this.say("No worries, I'll leave it as is.", "keep", true);
    }
    // Unclear — ask once more, then leave the booking as-is and close rather than
    // loop "cancel it?" forever (audit 2026-10-07: CANCEL_CONFIRM had no bound).
    this.cancelReasks++;
    if (this.cancelReasks >= 2) {
      this.cancelReasks = 0;
      this.state = "END";
      return this.say("No worries — I'll leave that booking as it is. Give us a quick call back anytime if you'd like to change it. Cheers!", "keep", true);
    }
    return this.say("Would you like me to cancel that booking — yes or no?", "cancel_confirm");
  }

  private async handleModifyWhat(text: string): Promise<ReservationTurn> {
    const changes: { date?: string; time?: string; partySize?: number } = {};
    // Only treat a number as a DATE when there's a real date word ("the 6th",
    // "Friday", "next week") — never a bare count like "6 people" (which used to be
    // read as the 6th AND 6 PM, moving the whole booking; live transcript 2026-10-06).
    if (this.hasDateWord(text)) {
      const d = normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays });
      if (d.date) changes.date = d.date;
    }
    // Only a genuine TIME cue (pm/am/o'clock/half/quarter/"at 8"…) sets the time.
    const tm = normaliseTime(text);
    if (tm.time && this.hasTimeCue(text)) changes.time = tm.time;
    // A party change needs a party phrase (people/guests/of us/party of/pax).
    const party = parsePartySize(text);
    if (party && /\b(people|persons?|guests?|pax|adults?|of us|party of|group of|table of|a party|a group)\b/i.test(text)) changes.partySize = party;
    // A bare number with an explicit change cue and no date/time/party word is a
    // party count ("make it six", "change it to four").
    if (changes.partySize === undefined && !changes.date && !changes.time && party && /\b(make it|change (?:it|that)(?:\s+to)?|just|to)\b/i.test(text)) {
      changes.partySize = party;
    }

    if (!changes.date && !changes.time && changes.partySize === undefined) {
      // Nothing to change parsed — ask once more, then leave it as-is and close
      // rather than loop forever (audit 2026-10-07: MODIFY_WHAT had no bound).
      this.modifyReasks++;
      if (this.modifyReasks >= 2) {
        this.modifyReasks = 0;
        this.state = "END";
        return this.say("No worries — I'll leave your booking as it is. Give us a quick call back whenever you'd like to change it. Cheers!", "keep", true);
      }
      return this.say("Sure — a new day, a new time, or a different number of people?", "modify_what");
    }
    this.modifyReasks = 0;
    let result: Awaited<ReturnType<typeof modifyReservation>>;
    try {
      result = await modifyReservation(this.ctx.db, {
        reservationId: this.candidates[0]!.id, changes,
        hours: this.ctx.hours, settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
      });
    } catch {
      this.state = "END";
      return this.say("I'm having a little trouble updating that right now — please give us a quick call back and we'll sort it. Cheers!", "modify_failed", true);
    }
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
      return this.say("That's not available, I'm afraid — is there another time that'd suit?", "modify_unavailable");
    }
    // Go to GREETING (not a dead END) so "yes, make a new one" actually books.
    this.state = "GREETING";
    return this.say("I couldn't find that booking anymore — would you like to make a new one?", "modify_notfound");
  }
}
