import type { Reservation } from "../types";
import { enqueueNotification } from "../domain/notifications";
import {
  checkAvailability, createReservation, cancelReservation, modifyReservation,
  findReservations, getReservationById, ReservationCapacityError, type AvailabilityResult,
} from "../domain/reservations";
import {
  type ReservationBrain, type ReservationContext, type ReservationDebug,
  type ReservationTurn, reservationGreetingVariants, speakDate, speakTime,
} from "./reservation-machine";
import {
  createReservationInterpreter, type Interpretation, type InterpreterInput,
  type ReservationInterpreter,
} from "./reservation-interpreter";
import { ReservationStateManager, type ResolutionProblem, type FieldName } from "./reservation-state";
import { detectSeating, detectVagueDate, detectVagueTime, interpretPartySize, isNo, isYes, parseName, parsePhone, parseSpelledName } from "./reservation-parse";
import { normaliseDate, normaliseTime } from "../domain/reservation-time";
import { env } from "../env";
import type { Llm } from "./llm";

/**
 * THE CONVERSATIONAL RESERVATION BRAIN (Kevin 2026-10-08 re-architecture).
 *
 * "STOP BUILDING A SCRIPTED BOOKING BOT. BUILD AN INTELLIGENT CONVERSATIONAL
 * RESERVATION ASSISTANT." This is the controller that wires the three pieces:
 *
 *   Scribe STT  ->  [ CONVERSATION INTERPRETER (LLM) ]  -> structured intent
 *               ->  [ RESERVATION STATE MANAGER ]        -> provenance + rules
 *               ->  [ deterministic engine ]             -> availability + DB
 *               ->  [ RESPONSE PLANNER ]                 -> Sally TTS
 *
 * It is a drop-in for ReservationMachine (same opening/next/debug/reservation
 * surface) selected behind BOOKING_BRAIN=llm. The LLM UNDERSTANDS each utterance;
 * this CODE decides, checks availability, writes to the DB, and plans the reply.
 *
 * Non-negotiables (Kevin's hard failures, all must be 0):
 *  - every utterance is interpreted fresh — never force it to answer the last Q;
 *  - a correction / question / change OUTRANKS the next booking field;
 *  - the actual question is answered BEFORE the booking resumes;
 *  - the latest correction supersedes the old value immediately;
 *  - availability is re-checked after any slot change (no stale "you're booked");
 *  - the DB row is consistency-checked before we ever say "all booked".
 * If the interpreter is unavailable/times out, the turn degrades gracefully
 * (ask again) rather than dropping the call.
 */

type Phase = "greeting" | "collecting" | "confirming" | "booked" | "ended";

type Pending =
  | { kind: "none" }
  | { kind: "confirm_booking" }
  | { kind: "confirm_party"; value: number }
  | { kind: "confirm_name"; value: string }
  | { kind: "confirm_date"; value: string }
  | { kind: "spell_name" }
  | { kind: "clarify_date"; options: { label: string; date: string }[] }
  | { kind: "clarify_time"; options: { label: string; time: string }[] }
  | { kind: "clarify_party"; options: number[] }
  | { kind: "offer_alternatives"; times: string[] }
  | { kind: "confirm_cancel"; reservationId: string }
  | { kind: "offer_hold" }
  | { kind: "soft_close"; which: "day" | "time" };

export interface BrainDeps {
  /** Interpreter to use. Injected in tests with a scripted fake; in production
   * built from the Anthropic Haiku LLM. */
  interpreter: ReservationInterpreter;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_HISTORY = 10; // last 5 exchanges — enough context, small for latency
const MAX_CLARIFY = 3; // after this many stuck clarifications, offer a call-back
const STUCK_LIMIT = 4; // global no-progress ceiling — never loop a caller forever
const MAX_POST_CONFIRM_OFFERS = 2; // "anything else?" re-offers before a warm close
// Last-resort loop net: the same exact question asked this many times in a row (with
// no booking progress) force-ends the call. Set ABOVE every principled bound
// (STUCK_LIMIT, MAX_CLARIFY, closedTurns, postConfirm) so it only ever catches a
// loop those missed — the real guarantee is the no-progress watchdog, this is the net.
const HARD_REPEAT_LIMIT = 6;
// Map the interpreter's BookingField names to the state manager's FieldName.
const FIELD_TO_STATE: Record<string, "date" | "time" | "partySize" | "name" | "phone"> = {
  date: "date", time: "time", party_size: "partySize", name: "name", phone: "phone",
};
// Biggest group we'll book straight into the party hall (above maxPartySize but
// within the function room's capacity). Above this → a team call-back. Owner-set.
const PARTY_HALL_MAX = env.PARTY_HALL_MAX_SIZE;

export class ConversationalReservationBrain implements ReservationBrain {
  reservation: Reservation | null = null;

  private phase: Phase = "greeting";
  private pending: Pending = { kind: "none" };
  private readonly state: ReservationStateManager;
  private readonly history: { role: "assistant" | "caller"; text: string }[] = [];
  private lastQuestion = "";
  private turn = 0;
  private clarifyStreak = 0;
  private holdCount = 0;
  private lastInterpretation: Interpretation | null = null;
  /** Text to prepend to the next spoken line — an answer to the caller's question
   * or an acknowledgement of a correction — so we ANSWER then RESUME in one breath
   * (Kevin's #1 failure: never ignore the actual question). Consumed once by resume(). */
  private turnLead = "";
  /** Global no-progress watchdog (Kevin: "no blockages"). Counts consecutive turns
   * that did not advance the booking; after STUCK_LIMIT we stop re-asking and take a
   * call-back note so a caller is NEVER trapped — every call ends in a booking or a
   * graceful hand-off. Reset whenever a value is captured / a question is answered. */
  private noProgress = 0;
  private sigAtTurnStart = "";
  private answeredSomething = false;
  /** Bounded "anything else?" re-offers after a booking is confirmed. */
  private postConfirmOffers = 0;
  /** We've given the one soft "…or shall I book now?" beat after a vague date/time,
   * so we never hard-drop a caller who might still want to book (Kevin 2026-10-09),
   * but also never re-ask "what day?" on a loop. */
  private softCloseOffered = false;
  /** Guard against the "the team will confirm" fallback LOOPING (Kevin 2026-10-09):
   * count genuinely-unanswerable questions, and whether the last question was really
   * answered (a real answer is progress; an unanswerable deflection is NOT, so it can't
   * keep resetting the no-progress watchdog). */
  private unanswerableCount = 0;
  private answeredRealQuestion = true;
  /** Times we've hit a too-large party — one gentle read-back, then a call-back
   * note (the team handles big groups). Never loops the "how many" question. */
  private largePartyTurns = 0;
  /** The caller explicitly asked for the party hall / function room (as opposed to
   * being auto-routed there for a big group). Set in captureExtras; makes even a
   * small group a party-hall booking. Big groups are detected from the size, so
   * whether THIS is a hall booking is recomputed fresh by isPartyHallBooking(). */
  private explicitHallRequest = false;
  /** Consecutive times availability came back CLOSED — bounded so a caller who
   * keeps landing outside our hours is handed to a call-back, never looped
   * "we're actually closed then" forever (Kevin 2026-10-09 live call). */
  private closedTurns = 0;
  /** Consecutive turns that asked the EXACT same question without the booking
   * advancing — the last-resort universal loop net (see emit()). */
  private sameQuestionStreak = 0;
  /** Consecutive turns the interpreter was unreachable (dead key / timeout). */
  private degradedStreak = 0;
  /** We've logged a team call-back note for this call (log once, never spam). */
  private heldForCallback = false;
  /** A relative date (e.g. "three weeks from now") resolved to a far-out day — we
   * ground it by reading the concrete calendar date back for confirmation before
   * relying on it, so a mis-count is never silently booked (Kevin 2026-10-10 Day 3). */
  private dateNeedsGrounding = false;
  /** NAME RECOVERY (Day 4): how many times we've failed to get the name (drives
   * repeat → spell escalation), how many spelling attempts missed, and whether we've
   * given up on the name and deferred it to the team (booking continues WITHOUT a
   * name — never abandoned, never a hallucinated name). */
  private nameAttempts = 0;
  private spellMisses = 0;
  private nameDeferred = false;
  private nameFlagSent = false; // staff alert for an unresolved name sent once
  private extrasDirty = false;  // a note (occasion/seating/special) was added and still needs persisting
  private lastSmsBody = "";     // debounce the confirmation SMS so a tweak doesn't re-text identical content
  /** We've routed a too-big group to the team — stay on the line and keep helping
   * (answer questions, take notes), but don't re-read the large-party line every turn
   * (Kevin 2026-10-10 Day 6). Clears if the party is corrected down to a bookable size. */
  private largePartyRouted = false;
  /** Rotating re-ask lead-ins so a repeated question is NEVER heard verbatim twice
   * in a row — it's re-asked in a fresh, human way instead (Kevin 2026-10-09). */
  private readonly reaskLeads = [
    "Sorry, I think I missed that", "Let me try that again", "No rush at all",
    "Just so I get it right", "Apologies, one more time", "That's alright",
  ];
  private reaskIdx = Math.floor(Math.random() * 6);
  /** Normalised text of the last line spoken — to catch a verbatim line repeat and
   * re-word it so the caller never hears the exact same sentence twice. */
  private lastSayNorm = "";
  /** Extras captured during the call and written onto the booking / call-back note:
   * a seating/area preference, an occasion, and whether we've offered the romantic
   * table for an anniversary (offer it at most once). */
  private seatingPref = "";
  private readonly extras: string[] = [];
  /** Offered a special seating suggestion for an occasion (romantic for an
   * anniversary, a nice surprise spot for a birthday) — at most once per call. */
  private offeredSpecialSeating = false;
  /** Offered the size-tiered area/occasion suggestion (once per booking). */
  private offeredArea = false;

  // Calm, understated acknowledgements — real politeness is listening, not gushing
  // (Kevin 2026-10-10 Day 5: stop the excessive "Perfect/Lovely/Wonderful/Brilliant").
  private readonly acks = ["Sure", "Of course", "No worries", "Right", "Okay", "Got it"];
  private ackIdx = Math.floor(Math.random() * 6);
  /** We've acknowledged the caller's frustration once — don't keep apologising. */
  private frustrationAcked = false;

  private readonly timeWin?: { openMin: number; closeMin: number };

  constructor(private readonly ctx: ReservationContext, private readonly deps: BrainDeps) {
    this.timeWin = openingWindow(ctx.hours);
    this.state = new ReservationStateManager({
      now: ctx.now,
      timezone: ctx.timezone,
      maxAdvanceDays: ctx.settings.maxAdvanceDays,
      timeWindow: this.timeWin,
    });
  }

  /** Build the production brain from an Anthropic Haiku LLM. */
  static fromLlm(ctx: ReservationContext, llm: Llm, log?: BrainDeps["log"]): ConversationalReservationBrain {
    const interpreter = createReservationInterpreter(llm, {
      restaurantName: ctx.restaurantName,
      // Above the model's observed ~1.4–1.6s so a normal turn never trips the
      // fallback; only a genuinely stuck call degrades to a re-ask.
      timeoutMs: 2800,
      log,
    });
    return new ConversationalReservationBrain(ctx, { interpreter, log });
  }

  /** Lines worth pre-synthesising for instant playout — identical greetings to the
   * deterministic machine (shared source) plus the brain's fixed closes. */
  static fixedSpeech(restaurantName: string): string[] {
    const out: string[] = [];
    for (const notice of ["", " This call may be recorded."]) {
      out.push(...reservationGreetingVariants(restaurantName, notice));
    }
    out.push(
      "It's my pleasure — have a wonderful day, and thanks so much for calling!",
      "No problem at all — take your time, I'm right here.",
    );
    return out;
  }

  opening(opts: { recordingNotice?: boolean } = {}): string {
    const notice = opts.recordingNotice ? " This call may be recorded." : "";
    const line = pick(reservationGreetingVariants(this.ctx.restaurantName, notice));
    this.lastQuestion = "Are you looking to book a table?";
    return line;
  }

  /** Re-ask the current question for the silence watchdog — warm, not a timer phrase. */
  gentleReprompt(): string {
    if (this.phase === "booked") return "No rush — anything else I can help with, or are you all set?";
    return this.lastQuestion || "How can I help — would you like to book a table?";
  }

  /** A multi-step NAME recovery (asking the caller to spell it, or confirming a
   * spelled candidate) is under way — the silence watchdog must not end the call in
   * the middle of it (Kevin 2026-10-10 silence rule: "no name spelling flow in
   * progress"). */
  midCriticalFlow(): boolean {
    return this.pending.kind === "spell_name" || this.pending.kind === "confirm_name";
  }

  debug(): ReservationDebug {
    const v = this.state.values();
    return {
      state: this.phaseAsState(),
      draft: { date: v.date, time: v.time, partySize: v.partySize, name: v.name, phone: v.phone },
      pendingParty: this.pending.kind === "confirm_party" ? this.pending.value : undefined,
      reasks: { date: 0, time: 0, party: 0, name: 0, phone: 0 },
    };
  }

  // ----------------------------------------------------------------- turn

  async next(text: string): Promise<ReservationTurn> {
    this.turn++;
    this.pushHistory("caller", text);
    // Snapshot booking progress so the watchdog (in emit) can tell whether this
    // turn actually advanced the booking or was another stuck re-ask.
    this.sigAtTurnStart = this.progressSig();
    this.answeredSomething = false;
    if (this.phase === "ended") return this.emit("Thanks so much for calling — take care!", "ended", true);

    // DEGENERATE STT guard: the line's speech-to-text sometimes HALLUCINATES a
    // repetitive run ("1, 2, 3 … 127", or one word over and over) from noisy/echoey
    // audio (Kevin 2026-10-10: his spoken NAME came through as counting). Never feed
    // that to the interpreter — it mis-reads as ABANDON or a huge party. Treat it as
    // "didn't catch" and gently re-ask; the watchdog bounds it and a complete booking
    // still books (never a hang-up, never a loop).
    if (isDegenerateStt(text)) {
      // A garbled run AT THE NAME STEP must enter the name-recovery hierarchy
      // (re-ask → spell → confirm → defer to caller-ID with a staff flag) — we do
      // NOT book a nameless reservation just because the STT fell apart (Kevin
      // 2026-10-10 final acceptance: understand the name first; caller-ID is the
      // LAST resort, flagged, never a guessed name).
      if (this.pending.kind === "spell_name") {
        this.spellMisses++;
        // Line too broken to spell either → keep the booking under the caller's number
        // (the caller can't reliably confirm, so complete it now, name flagged).
        if (this.spellMisses >= 2) return await this.deferName(true);
        return this.resume("sorry, I didn't quite get that — could you spell it slowly, one letter at a time?", { question: true });
      }
      if (this.atNameStep()) return this.nameRecovery();
      if (this.stuck()) return this.offerHoldClose();
      const clean = this.lastQuestion;
      return this.emit(clean
        ? `Sorry, I didn't catch that — ${lowerFirst(clean)}`
        : "Sorry, I didn't catch that — could you say that again?", "degraded");
    }

    // Fast-path: a clean yes/no to a pending confirmation is handled instantly,
    // with NO LLM round-trip — so the commonest turns stay sub-millisecond. Any
    // utterance with real content (a value, a change, a question) goes to the LLM.
    const fast = this.fastInterpret(text);
    let interp = fast ?? await this.deps.interpreter.interpret(this.interpreterInput(text));
    // RESILIENCE (Kevin 2026-10-09 "no more trouble"): if the LLM interpreter is
    // unreachable (dead/expired API key, or a timeout), fall back to DETERMINISTIC
    // parsing so the booking STILL works with no key at all — the brain reads the
    // date/time/party/name/phone straight off the utterance with the proven parsers.
    // Only when that finds nothing usable do we degrade to a re-ask.
    if (!fast && interp.confidence === 0 && interp.reasoning.startsWith("interpreter-unavailable")) {
      const det = this.deterministicInterpret(text);
      if (det) { interp = det; this.degradedStreak = 0; }
    }
    this.lastInterpretation = interp;
    this.deps.log?.("brain-turn", { turn: this.turn, phase: this.phase, pending: this.pending.kind, intent: interp.primary_intent, fast: fast !== null, det: interp.reasoning === "deterministic-fallback", entities: Object.keys(interp.entities), corrections: interp.corrections.map((c) => c.field) });

    // Interpreter unavailable (dead/invalid API key, or a timeout) — degrade, never
    // drop. ONE gentle re-ask; if it's STILL unreachable the very next turn (a dead
    // key fails every turn, so re-asking just repeats the same question — Kevin
    // 2026-10-09 "no looping"), hand off gracefully instead of asking again.
    if (interp.confidence === 0 && interp.reasoning.startsWith("interpreter-unavailable")) {
      this.degradedStreak++;
      if (this.degradedStreak >= 2 || this.stuck()) return this.offerHoldClose();
      const clean = this.lastQuestion;
      const turn = this.emit(clean
        ? `Sorry, I didn't quite catch that — ${lowerFirst(clean)}`
        : "Sorry, I didn't quite catch that — could you say that again?", "degraded");
      if (clean) this.lastQuestion = clean;
      return turn;
    }
    this.degradedStreak = 0; // interpreter responded — reset the outage guard

    // "Just use the number I'm calling from" / "the same number" → take the caller
    // ID as the phone, don't send the phrase to the parser (it isn't a dialable
    // number, and the old path looped "could you say that once more?"; Kevin
    // 2026-10-09). Only when we actually have a caller ID and they didn't also
    // read out a real number in the same breath.
    if (this.ctx.callerPhone && refersToOwnNumber(text) && !parsePhone(text)) {
      delete (interp.entities as Record<string, unknown>).phone;
      interp.corrections = interp.corrections.filter((c) => c.field !== "phone");
      this.state.setPhone(this.ctx.callerPhone, text, this.turn);
      this.answeredSomething = true;
    }

    // NAME SPELLING collection (Day 4) — we asked the caller to spell the name, so
    // this turn is a sequence of letters, not a normal field answer. Assemble them.
    // If they instead said something else (a question, a change, a plain name), this
    // returns null and we handle the turn normally.
    if (this.pending.kind === "spell_name") {
      const handled = await this.handleSpellName(text, interp);
      if (handled) return handled;
    }

    // Does the caller clearly want to finish? Computed early so it OUTRANKS the
    // out-of-scope / undecided branches below (Kevin 2026-10-10: an explicit end must
    // win). The actual end happens at the guarded explicit-end step once we've
    // confirmed there's no fresh info / correction / question this turn.
    // A YES to a pending confirmation OUTRANKS any end-phrase: "yeah, I'm good" at the
    // lock-in means "yes, book it", not "I'm done, goodbye" — ending there LOST the
    // booking on a live call (Kevin 2026-10-10). Same family as "that's all right".
    const awaitingConfirm = ["confirm_booking", "confirm_party", "confirm_name", "confirm_date", "offer_alternatives", "offer_hold"].includes(this.pending.kind);
    const affirming = interp.confirmation || isYes(text) || /^\s*(yeah|yep|yes|sure|ok|okay|alright|all right|go ahead|please do|lock it in|that'?s right|sounds good)\b/i.test(text);
    const endWants = (saysEndIntent(text) || interp.request_to_end_call) && !(awaitingConfirm && affirming);

    // 0) UNDECIDED date/time while still collecting — do NOT start a re-ask dance;
    //    give ONE warm "call back once decided, or shall I book now?" beat (handled
    //    once, via softCloseOffered). Gated on the parser failing so a real date books.
    if (!endWants && this.phase !== "booked" && !this.reservation && !this.softCloseOffered) {
      if (!this.state.fields.date && detectVagueDate(text) &&
          !normaliseDate(text, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays }).date) {
        return this.undecidedClose("day");
      }
      if (this.state.fields.date && !this.state.fields.time && detectVagueTime(text) && !normaliseTime(text).time) {
        return this.undecidedClose("time");
      }
    }

    const allIntents = new Set([interp.primary_intent, ...interp.secondary_intents]);

    // 1) ABANDON — only end the call when the caller EXPLICITLY says so ("forget it",
    //    "never mind", "cancel the call", "bye"). NEVER hang up on an INFERRED abandon
    //    (Kevin 2026-10-10: he gave his name, the line's STT garbled it, the LLM read
    //    the gibberish as ABANDON and the call was "rudely cut" — very bad). With no
    //    explicit cue we fall through and handle the turn normally (re-ask / just book),
    //    so a mis-heard answer can never drop the call.
    if (allIntents.has("ABANDON") && saysAbandon(text)) return this.handleAbandon();

    // 2) WAIT / hold — be gracious; hold, then (if it persists) offer a call-back.
    if (interp.request_to_wait || allIntents.has("WAIT")) return this.handleWait();

    // 3) Out-of-scope (food order etc.) before booking is done — steer back warmly.
    //    (An explicit end outranks this — handled at the explicit-end step.)
    if (!endWants && allIntents.has("OUT_OF_SCOPE") && !interp.customer_question && this.phase !== "booked") {
      return this.resume("I can only help with table bookings on this line, I'm afraid.");
    }

    // 4) Apply every entity + correction to the booking FIRST, so a value given in
    //    the same breath as a question/confirmation is never lost.
    const expectingParty = this.lastAskedField() === "partySize" || this.state.nextMissing({ needPhone: this.needPhone() }) === "partySize";
    const applied = this.state.apply(interp, text, this.turn, { expectingParty });
    if (applied.resolutions.length) this.clarifyStreak = 0;
    this.deps.log?.("brain-apply", {
      resolutions: applied.resolutions.map((r) => `${r.field}:${r.kind}=${r.value}`),
      problems: applied.problems.map((p) => `${p.field}:${p.reason}`),
      slotChanged: applied.slotChanged,
    });
    // Capture a seating/area preference, occasion, or special/dietary request to note
    // on the booking (semantic signals from the interpreter + the caller's words).
    this.captureExtras(text, interp);
    // UNCERTAINTY → CONFIRM, never guess (Kevin 2026-10-10): a field the interpreter
    // flagged as unsure (a name on a noisy line) is marked low-confidence so advance()
    // reads it back for confirmation rather than trusting it. Only for values set THIS
    // turn, so a previously-confirmed value isn't downgraded.
    for (const f of interp.uncertain_fields) {
      const sf = FIELD_TO_STATE[f];
      if (!sf) continue;
      const fld = this.state.fields[sf];
      if (fld && fld.turn === this.turn) this.state.markUncertain(sf);
    }
    // CALENDAR GROUNDING (Day 3): a date given as a RELATIVE expression that lands
    // more than a week out ("three weeks from now", "the Saturday after next") is
    // error-prone to mis-count — flag it so advance() reads the concrete calendar date
    // back for confirmation. An explicit calendar date ("14 November") needs no grounding.
    const dateRes = applied.resolutions.find((r) => r.field === "date" && r.kind !== "unchanged");
    if (dateRes) {
      const datePhrase = interp.corrections.find((c) => c.field === "date")?.phrase ?? interp.entities.date?.phrase ?? text;
      const iso = this.state.fields.date?.value;
      this.dateNeedsGrounding = !!iso && looksRelativeDate(datePhrase) && isoDaysBetween(this.todayIso(), iso) > 7;
    }

    // 5) Acknowledge a correction (and/or frustration) SPECIFICALLY, once, then ACT
    //    (Kevin 2026-10-10 Day 5): name exactly what changed; if the caller told US we
    //    were wrong, own it ("you're right"); if they're frustrated, one brief genuine
    //    sorry folded in — never two apologies, never generic customer-service filler.
    const correctedFields = applied.resolutions.filter((r) => r.kind === "corrected");
    let correctionAck = "";
    if (correctedFields.length) {
      const f = correctedFields[0]!;
      const human = this.describeValue(f.field, f.value);
      correctionAck = interp.assistant_was_corrected
        ? `you're right — I've changed the ${speakField(f.field)} to ${human}`
        : `done — ${speakField(f.field)} ${human}`;
    }
    if (interp.frustrated && !this.frustrationAcked) {
      this.frustrationAcked = true;
      this.answeredSomething = true; // engaging with the caller's feeling, not a stall
      correctionAck = correctionAck ? `sorry about that — ${correctionAck}` : "sorry about that, let me sort it";
    }
    if (correctionAck) correctionAck = capFirst(correctionAck);

    // 6) REPEAT — read the reservation back and, if we're at the lock-in step, ask
    //    them to confirm again (Kevin 2026-10-08: "if the customer asks to repeat,
    //    only repeat; otherwise read out the reservation and ask them to confirm").
    if (interp.request_to_repeat || allIntents.has("REQUEST_REPEAT")) {
      this.answeredSomething = true; // legitimate engagement, not a stuck re-ask
      const summary = this.readBackSummary();
      const lead = this.pending.kind === "confirm_booking" ? `${summary} Shall I lock that in?` : summary;
      return this.resume("", { lead });
    }

    // 7) A QUESTION we must answer BEFORE resuming the booking (Kevin's #1 failure).
    //    Queue the answer as this turn's lead, then CARRY ON with the booking so the
    //    caller hears the answer AND the next step in one breath.
    if (interp.customer_question) {
      this.turnLead = this.answerQuestion(interp.customer_question);
      // A REAL answer is progress; a "the team will confirm" deflection is NOT, so a
      // caller who only asks unanswerable things is bounded by the no-progress watchdog
      // (→ graceful call-back close) instead of looping the fallback forever.
      this.answeredSomething = this.answeredRealQuestion;
    }

    // 7.5) EXPLICIT END — the ONLY assistant-initiated termination (Kevin 2026-10-10
    //      ABSOLUTE NO-HANG-UP POLICY). End only when the caller CLEARLY signals they're
    //      finished ("that's all", "bye", "nothing else"), with nothing unresolved this
    //      turn — no question to answer, no correction, no fresh detail to apply. An
    //      unclear/odd/garbled turn is NEVER an end; everything else keeps the line open.
    if (endWants && !interp.customer_question && !correctedFields.length &&
        !applied.resolutions.some((r) => r.kind !== "unchanged") && !applied.problems.length) {
      return this.endWarmly();
    }

    // 8) Resolution problems (ambiguous / invalid value) — ask the specific fix, in
    //    ANY phase. This runs BEFORE the booked-phase handler so an impossible or
    //    unclear value a caller gives (even when changing an existing booking) is
    //    SURFACED and clarified, never silently dropped (Kevin 2026-10-10 Day 8:
    //    "31st of November" must not become a quiet "okay, anything else?").
    if (applied.problems.length) {
      // An unparseable NAME goes into the Day-4 recovery subflow (repeat → spell →
      // confirm → defer), NEVER a bare re-ask that could strand the caller.
      if (applied.problems[0]!.field === "name") return this.nameRecovery(correctionAck);
      return this.askAboutProblem(applied.problems[0]!, correctionAck);
    }

    // 9) Already booked — handle changes / cancel / "anything else" / ring-off.
    if (this.phase === "booked") {
      const handledBooked = await this.handleBooked(interp, allIntents, applied.slotChanged, text);
      if (handledBooked) return handledBooked;
    }

    // 10) Confirmation / negation against a pending operation.
    if (this.pending.kind !== "none") {
      const handled = await this.handlePending(interp, correctionAck);
      if (handled) return handled;
    }

    // 11) Existing-booking cancel (caller referenced a booking already made).
    if ((allIntents.has("CANCEL_BOOKING") || interp.request_to_cancel) && this.phase !== "confirming") {
      const c = await this.handleCancelIntent();
      if (c) return c;
    }

    // 12) Drive the booking forward.
    return this.advance(correctionAck);
  }

  /** After a booking is confirmed we stay on the line: apply a change they ask
   * for, cancel on request, or ring off warmly. Never loops "anything else?". */
  private async handleBooked(interp: Interpretation, allIntents: Set<string>, slotChanged: boolean, text: string): Promise<ReservationTurn | null> {
    // A cancellation request is handled by the cancel path below — let it through.
    if (allIntents.has("CANCEL_BOOKING")) return null;
    // A change to the live booking — a slot change (date/time/party) OR a note added
    // after confirmation (occasion/seating/special). Re-check availability if the slot
    // moved, persist to the DB row, and RE-SEND the confirmation SMS so the text always
    // matches the final saved record (Kevin 2026-10-10: no stale SMS, occasion saved).
    if ((slotChanged || this.extrasDirty) && this.reservation) {
      const v = this.state.values();
      const notesChangedOnly = !slotChanged && this.extrasDirty;
      this.extrasDirty = false;
      let result: Awaited<ReturnType<typeof modifyReservation>>;
      try {
        result = await modifyReservation(this.ctx.db, {
          reservationId: this.reservation.id,
          changes: { date: v.date, time: v.time, partySize: v.partySize, specialRequests: this.specialRequests() },
          hours: this.ctx.hours, settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
        });
      } catch {
        return this.resume("I couldn't change that just now, so I've kept your booking as it was. Anything else?", { question: true });
      }
      if ("reservation" in result) {
        this.reservation = result.reservation;
        this.state.setAvailability({ status: "AVAILABLE", alternatives: [] });
        void this.sendConfirmationSms(result.reservation); // keep the SMS in sync with the saved record
        const r = result.reservation;
        // A note-only change (e.g. "it's my wife's birthday" after booking) is acked as a
        // note, not a table read-back; a slot change reads the new table back.
        if (notesChangedOnly) {
          const lead = this.turnLead.trim(); this.turnLead = "";
          return this.resume(`${lead ? lead + " " : ""}I've added that to your booking. Anything else?`, { question: true });
        }
        return this.resume(`that's now a table for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}. Anything else?`, { question: true });
      }
      if ("unavailable" in result) {
        const alts = result.unavailable.alternatives.slice(0, 2).map(speakTime);
        return this.resume(alts.length ? `that's not available, but I've got ${alts.join(" or ")} — would either work?` : "that's not available, I'm afraid — is there another time that'd suit?", { question: true });
      }
    }
    // Ringing off: a clear done / no / thanks keeps the booking and ends warmly.
    if (interp.negation || saysDone(text)) {
      return this.emit(pick(["It's my pleasure — have a wonderful day, and thanks so much for calling!", "Lovely — enjoy your meal, and thanks for calling!"]), "goodbye", true);
    }
    // Otherwise (an answered question, or an unclear reply) gently re-offer — but
    // NEVER loop: after a couple of "anything else?"s, close warmly. The booking
    // already stands, so we never fall through to a spurious re-confirmation.
    this.postConfirmOffers++;
    if (this.postConfirmOffers > MAX_POST_CONFIRM_OFFERS) {
      return this.emit(pick(["It's my pleasure — have a wonderful day, and thanks so much for calling!", "Lovely — enjoy your meal, and thanks for calling!"]), "goodbye", true);
    }
    return this.resume("Anything else I can help with, or are you all set?", { question: true });
  }

  /**
   * Resolve the OBVIOUS turns without the LLM so the happy path stays instant and
   * the ~1.3s interpreter cost is spent only on genuine curveballs. Two cases, both
   * with deliberately strict guards (a false fast-path would drop a correction):
   *   (a) a clean yes/no to a pending confirmation;
   *   (b) a clean answer to the exact field we just asked, with ZERO nuance markers.
   * ANY hint of a correction, question, change, hold, or multi-intent → null, and
   * the turn goes to the interpreter where understanding matters. This is "code for
   * the simple, AI for the hard" — not a return to the scripted bot: the moment a
   * turn is anything but a plain answer, the LLM decides.
   */
  private fastInterpret(text: string): Interpretation | null {
    const t = text.trim();
    if (!t) return null;

    // (a) yes / no to a pending confirmation.
    const awaitingYesNo = ["confirm_booking", "confirm_party", "confirm_name", "confirm_date", "confirm_cancel", "offer_alternatives"].includes(this.pending.kind);
    if (awaitingYesNo) {
      const words = t.split(/\s+/).filter(Boolean);
      if (words.length <= 3 && t.length <= 24 &&
          !/\d|\b(change|instead|actually|but|wait|move|different|make it|put|under|or|also|what|when|where|why|how|sorry|hang on|hold on|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(t)) {
        const yes = isYes(t), no = isNo(t);
        if (yes && !no) return { ...emptyInterp(), primary_intent: "AFFIRM", confidence: 1, confirmation: true };
        if (no && !yes) return { ...emptyInterp(), primary_intent: "NEGATE", confidence: 1, negation: true };
      }
      return null; // awaiting yes/no but it wasn't a clean one — the LLM reads it
    }

    // (a2) greeting: a plain "yes" / "I'd like to book a table" with NO booking
    // details and no cancel/change intent → go straight to asking the first detail,
    // instantly, no LLM. Removes the ~1.4s pause on the very first exchange. Anything
    // with a detail, or a cancel/change, still goes to the LLM so nothing is missed.
    if (this.phase === "greeting" && !hasEntitySignal(t) &&
        !/\b(cancel|change|move|modify|reschedule|existing|already|my (booking|reservation|table))\b/i.test(t) &&
        (isYes(t) || /\b(book|booking|reserve|reservation|table|make a)\b/i.test(t))) {
      return { ...emptyInterp(), primary_intent: "NEW_RESERVATION", confidence: 0.9 };
    }

    // (b) a plain answer to the field we just asked.
    if (this.pending.kind !== "none") return null;
    const field = this.lastAskedField();
    if (!field) return null;
    const words = t.split(/\s+/).filter(Boolean);
    // Nuance markers (NOT numbers — a number is a valid field answer) → let the LLM.
    if (words.length > 8 || /\?|\b(actually|instead|change|changed|make it|rather|scrap|i mean|not|no|nope|wait|sorry|hang on|hold on|one sec|one moment|also|plus|and|or|what|when|where|why|how|which|do you|can you|could you|would you|are you|is it|cancel|forget)\b/i.test(t)) {
      return null;
    }
    // COMBINED / CROSS-FIELD INFO (Kevin 2026-10-10 acceptance): the fast path must only
    // fire on a CLEAN answer to the asked field. If the utterance carries a marker for a
    // DIFFERENT field, hand the whole thing to the LLM so NOTHING is dropped or mis-filed.
    // Markers include SPELLED numbers ("three people", "eight o'clock") and a name cue —
    // the gaps that made "three people" read as 3 o'clock and "eight o'clock" as party 8.
    const NUMWORD = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
    const timeMark = new RegExp(`\\b\\d{1,2}\\s*[:.]\\s*\\d{2}\\b|\\b\\d{1,2}\\s*(?:am|pm|a\\.?m\\.?|p\\.?m\\.?)\\b|\\b(?:\\d{1,2}|${NUMWORD})\\s*o'?clock\\b|\\bo'?clock\\b|\\bhalf (?:past|${NUMWORD})\\b|\\bquarter (?:past|to)\\b|\\b(?:noon|midday|midnight)\\b|\\bat\\s+(?:\\d|noon|half|quarter|${NUMWORD})\\b`, "i");
    const dateMark = /\b(today|tonight|tomorrow|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|fortnight|next week|next month|this (?:coming )?(?:week|weekend)|\d{1,2}(?:st|nd|rd|th)|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
    const partyMark = new RegExp(`\\b(?:table )?for\\s+(?:\\d{1,2}|a couple|couple|${NUMWORD})\\b|\\b(?:\\d{1,2}|${NUMWORD}|a couple|couple)\\s+(?:people|of us|guests?|persons?|pax|adults?|kids?|diners?)\\b|\\bparty of\\b|\\bjust (?:me|the two|us)\\b|\\bdozen\\b`, "i");
    const nameMark = /\b(?:the )?name\b|\bunder\b|\bit's\s+(?:called\s+)?[A-Z]/;
    const carriesOtherField =
      (field !== "time" && timeMark.test(t)) ||
      (field !== "date" && dateMark.test(t)) ||
      (field !== "partySize" && partyMark.test(t)) ||
      (field !== "name" && nameMark.test(t));
    if (carriesOtherField) return null;
    const entity = (f: "date" | "time" | "party_size" | "name" | "phone"): Interpretation =>
      ({ ...emptyInterp(), primary_intent: "PROVIDE_BOOKING_INFORMATION", confidence: 0.97, entities: { [f]: { phrase: t, confidence: 0.97 } } });
    switch (field) {
      case "date": if (normaliseDate(t, { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays }).date) return entity("date"); return null;
      case "time": if (normaliseTime(t, this.timeWin).time) return entity("time"); return null;
      case "partySize": if (interpretPartySize(t, { expectingParty: true }).kind === "value") return entity("party_size"); return null;
      case "name": if (parseName(t)) return entity("name"); return null;
      case "phone": if (parsePhone(t)) return entity("phone"); return null;
      default: return null;
    }
  }

  /**
   * DETERMINISTIC fallback interpretation — used ONLY when the LLM interpreter is
   * unreachable (dead/expired API key or a timeout), so the booking still works with
   * no key (Kevin 2026-10-09: "no more trouble"). Reads whatever booking fields are
   * present straight off the utterance with the proven parsers. Deliberately
   * CONSERVATIVE and field-aware to avoid cross-contamination (a bare "four" answering
   * "how many?" must become party 4, never 4 o'clock): a time needs an explicit clock
   * signal (or that we asked for the time); a party needs a people-signal (or that we
   * asked); name/phone only when we asked. The read-back + confirm still guard it.
   * Returns null when nothing usable is found, so the caller gets one gentle re-ask.
   */
  private deterministicInterpret(text: string): Interpretation | null {
    const t = text.trim();
    if (!t) return null;
    const asked = this.lastAskedField();
    const dctx = { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays };
    const entities: Record<string, { phrase: string; confidence: number }> = {};

    // DATE — normaliseDate is content-specific (won't fire on a bare number), so trust it.
    if (normaliseDate(t, dctx).date) entities.date = { phrase: t, confidence: 0.75 };
    // TIME — only on an explicit clock signal, or when we actually asked the time, so a
    // bare "four" answering "how many?" is never read as 4 o'clock.
    const timeSignal = /\d\s*[:.h]\s*\d|\b\d{1,2}\s*(?:am|pm|a\.?m\.?|p\.?m\.?|o'?clock)\b|\b(noon|midday|midnight|half|quarter)\b/i.test(t);
    if ((asked === "time" || timeSignal) && normaliseTime(t, this.timeWin).time) entities.time = { phrase: t, confidence: 0.75 };
    // PARTY — only when asked, or an explicit people/size signal.
    const partySignal = /\b(people|persons?|guests?|pax|of us|party of|table for|just me|couple|dozen)\b/i.test(t);
    if ((asked === "partySize" || partySignal) && interpretPartySize(t, { expectingParty: true }).kind === "value") {
      entities.party_size = { phrase: t, confidence: 0.75 };
    }
    // NAME / PHONE — only when we asked for them (avoid misreading a stray word).
    if (asked === "name" && parseName(t)) entities.name = { phrase: t, confidence: 0.7 };
    if (asked === "phone" && parsePhone(t)) entities.phone = { phrase: t, confidence: 0.9 };

    const yes = isYes(t), no = isNo(t);
    const hasEntity = Object.keys(entities).length > 0;
    const abandon = /\b(forget it|never mind|cancel the call|changed my mind|not interested)\b/i.test(t);
    if (!hasEntity && !yes && !no && !abandon) return null; // nothing usable → one gentle re-ask

    return {
      ...emptyInterp(),
      primary_intent: abandon ? "ABANDON" : hasEntity ? "PROVIDE_BOOKING_INFORMATION" : yes ? "AFFIRM" : "NEGATE",
      secondary_intents: abandon ? ["ABANDON"] : [],
      entities: entities as Interpretation["entities"],
      confirmation: yes && !no,
      negation: no && !yes,
      confidence: 0.7,
      reasoning: "deterministic-fallback",
    };
  }

  // ----------------------------------------------------------------- advance

  /** Decide and speak the next step: ask what's missing, confirm an uncertain
   * value, check availability, or read back for the final lock-in. */
  private async advance(correctionAck = ""): Promise<ReservationTurn> {
    // No-progress backstop: if we've been going in circles (a value we can't
    // capture, a confirmation that never comes), stop asking and take a call-back
    // note so the caller is never trapped (Kevin: no blockages).
    if (this.stuck()) return this.offerHoldClose();
    // Already routed a too-big group to the team — stay open and keep helping (answer
    // questions via the turnLead) without re-reading the large-party line, UNLESS they
    // corrected the party down to a size we can actually book (Kevin 2026-10-10 Day 6).
    if (this.largePartyRouted) {
      const ps = this.state.fields.partySize?.value;
      if (ps && ps <= PARTY_HALL_MAX) this.largePartyRouted = false;
      else return this.resume("Is there anything else I can help with, or any questions about it?", { question: true });
    }
    // A far-out RELATIVE date — ground it by reading the concrete calendar date back,
    // so a mis-counted "three weeks from now" is caught, never silently booked (Day 3).
    const dateF = this.state.fields.date;
    if (this.dateNeedsGrounding && dateF && !dateF.confirmed) {
      this.pending = { kind: "confirm_date", value: dateF.value };
      return this.resume(`just to check — that's ${speakDate(dateF.value)}?`, { ackCorrection: correctionAck, question: true });
    }
    // An uncertain party size we captured as a "candidate" — confirm it.
    const party = this.state.fields.partySize;
    if (party && !party.confirmed && this.needsPartyConfirm()) {
      this.pending = { kind: "confirm_party", value: party.value };
      return this.resume(`just to be sure — that's a table for ${party.value}?`, { ackCorrection: correctionAck, question: true });
    }
    // A low-confidence name — read it back before relying on it.
    const name = this.state.fields.name;
    if (name && !name.confirmed && this.needsNameConfirm()) {
      this.pending = { kind: "confirm_name", value: name.value };
      return this.resume(`I've got the name as ${name.value} — is that right?`, { ackCorrection: correctionAck, question: true });
    }

    // Skip the name once we've deferred it (the team will confirm it) — booking
    // continues, never stuck on a name we can't catch (Kevin 2026-10-10 Day 4).
    const missing = this.state.nextMissing({ needPhone: this.needPhone(), skipName: this.nameDeferred });
    if (missing) {
      this.phase = "collecting";
      return this.resume(this.askFor(missing), { ackCorrection: correctionAck, question: true });
    }

    // Everything present — read back for the lock-in (with a warm, size-tiered area
    // offer folded into that same line, so it's engaging without an extra turn).
    return this.toConfirmation(correctionAck);
  }

  /** NAME RECOVERY escalation (Day 4): first miss → ask them to say it again; second
   * miss → ask them to SPELL it (sets the spell_name collection state). We NEVER
   * abandon or hang up on an unclear name. */
  /** Are we at the point of collecting the customer's name — the slot (date/time/
   * party) is settled, a phone is on hand, and the name is the only thing still
   * missing and not yet deferred? Used so garbled STT at the name step routes into
   * name recovery rather than a silent nameless booking. */
  private atNameStep(): boolean {
    if (this.nameDeferred || this.state.values().name) return false;
    return this.state.nextMissing({ needPhone: this.needPhone(), skipName: false }) === "name";
  }

  private nameRecovery(correctionAck = ""): ReservationTurn {
    this.nameAttempts++;
    if (this.nameAttempts >= 2) {
      this.pending = { kind: "spell_name" };
      return this.resume("no worries — could you spell the name for me, one letter at a time?", { ackCorrection: correctionAck, question: true });
    }
    return this.resume("sorry, I didn't catch the name — could you say it once more?", { ackCorrection: correctionAck, question: true });
  }

  /** Collect a spelled-out name. Returns a turn when it resolved a name (→ confirm) or
   * is still recovering; returns null when the caller said something that ISN'T a
   * spelling (a question/change/plain name) so the normal flow handles it. */
  private async handleSpellName(text: string, interp: Interpretation): Promise<ReservationTurn | null> {
    const name = parseSpelledName(text) ?? parseName(text);
    if (name) {
      this.spellMisses = 0;
      this.nameDeferred = false;
      // Set the name from the spelling and read it back to confirm (spelled names are
      // easy to mishear a letter in).
      this.state.apply({ ...emptyInterp(), corrections: [{ field: "name", phrase: name, confidence: 0.85 }] }, text, this.turn);
      this.pending = { kind: "confirm_name", value: name };
      return this.resume(`got it — ${name}. Is that right?`, { question: true });
    }
    // Not a spelling. Bail to the normal flow ONLY if the caller clearly changed tack
    // — asked a question, wants to end/cancel, or gave a DIFFERENT field (date/time/
    // party/phone). A failed NAME attempt is not "changing tack" — it counts as a
    // spell miss below (so a garbled line can't escape into a re-ask loop).
    const otherField = interp.corrections.some((c) => c.field !== "name") ||
      (["date", "time", "party_size", "phone"] as const).some((f) => interp.entities[f]);
    if (interp.customer_question || interp.request_to_end_call || interp.request_to_cancel || saysEndIntent(text) || otherField) {
      this.pending = { kind: "none" };
      return null;
    }
    // Couldn't get the spelling — one more try, then DEFER to the team (never abandon).
    this.spellMisses++;
    if (this.spellMisses >= 2) return await this.deferName();
    return this.resume("sorry, I didn't quite get that — could you spell it slowly, one letter at a time?", { question: true });
  }

  /** Give up on capturing the name — WITHOUT abandoning the booking or inventing a
   * name. Keep everything else, note it for the team, and carry on (Kevin 2026-10-10:
   * "never pretend it heard a name"; "keep the booking details here"). */
  /** Give up on capturing the name after the full hierarchy — WITHOUT abandoning the
   * booking or inventing a name. `autoBook` completes the booking immediately under the
   * caller's number (for a line so broken the caller can't even confirm — the degenerate
   * STT path); otherwise we carry on to the normal lock-in read-back so an intelligible
   * caller still confirms. Either way the name is flagged unresolved for the team. */
  private async deferName(autoBook = false): Promise<ReservationTurn> {
    this.nameDeferred = true;
    this.spellMisses = 0;
    this.pending = { kind: "none" };
    this.state.clearField("name"); // never store a garbage transcription / guessed name
    // Honest, natural fallback (Kevin 2026-10-10): we have the caller's number, so the
    // booking is kept under THAT, the name is flagged unresolved for the team, and we
    // never pretend the name was captured. finaliseBooking stamps name_status=unresolved
    // + needs_staff_attention and alerts the team.
    this.turnLead = "I'm having trouble catching the name clearly, but I've got your number. I can keep the booking under that and flag the name for the team.";
    const phone = this.state.values().phone ?? this.ctx.callerPhone;
    if (autoBook && this.state.hasSlot() && phone) return this.finaliseBooking();
    return this.advance();
  }

  /** A warm, size-tiered space/occasion offer folded INTO the confirm read-back
   * (Kevin 2026-10-09: 8+ → party hall; 4+ → a particular area; 2+ → a special
   * occasion). Returned once per booking, "" thereafter or when we already know a
   * space/occasion. Phrased as a STATEMENT/invitation (not a second question) so the
   * confirm line asks exactly ONE thing — "Shall I lock that in?" — never two
   * questions in a breath (Kevin 2026-10-09: a perfect call). The caller can still
   * respond to it (an occasion/area is captured) or just say yes. */
  private areaClauseOnce(p?: number): string {
    if (this.offeredArea || !p) return "";
    this.offeredArea = true;
    if (p > this.ctx.settings.maxPartySize) return ""; // too large -> party-hall call-back handles it
    const haveArea = this.extras.some((e) => /hall|window|booth|outdoor|indoor|quiet|romantic|surprise|spot|area/i.test(e));
    const haveOcc = this.extras.some((e) => /anniversary|birthday|engagement|proposal|honeymoon/i.test(e));
    if (haveArea) return "";
    if (p >= 8) return ` For a group that size we've got a lovely party hall, or a particular area if you'd prefer.`;
    if (p >= 4) return ` We can set you up somewhere nice too — a window table, a cosy booth, or somewhere quieter.`;
    if (!haveOcc) return ` And do let me know if it's a special occasion, a birthday or anniversary.`;
    return "";
  }

  private async toConfirmation(correctionAck = ""): Promise<ReservationTurn> {
    const v = this.state.values();
    // A party-hall booking (a big group above the per-table limit but within the
    // hall's capacity, or an explicit hall request) uses the hall — its own space,
    // no per-table size cap or cover limit, though opening hours still apply.
    let avail = this.state.freshAvailability();
    if (!avail) {
      try {
        avail = await checkAvailability({
          db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
          settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
          date: v.date!, time: v.time!, partySize: v.partySize!,
          allowPartyHall: this.isPartyHallBooking(),
        });
        this.state.setAvailability(avail);
      } catch {
        return this.resume("I'm having a little trouble checking that just now — could you bear with me, or would another time suit?");
      }
    }
    return this.speakAvailability(avail, correctionAck);
  }

  /** Is this booking a party-hall booking RIGHT NOW? True for a big group above
   * the per-table limit but within the hall's capacity, or when the caller asked
   * for the hall by name. Recomputed from the current party size, so a correction
   * back down to a normal size drops the hall automatically (Kevin 2026-10-09). */
  private isPartyHallBooking(): boolean {
    const p = this.state.values().partySize;
    const bigGroup = !!p && p > this.ctx.settings.maxPartySize && p <= PARTY_HALL_MAX;
    return bigGroup || this.explicitHallRequest;
  }

  private speakAvailability(avail: AvailabilityResult, correctionAck = ""): ReservationTurn {
    const v = this.state.values();
    switch (avail.status) {
      case "AVAILABLE": {
        this.closedTurns = 0; // landed on an open slot — reset the closed guard
        this.phase = "confirming";
        this.pending = { kind: "confirm_booking" };
        const who = v.name ? ` for ${v.name}` : "";
        // A big group (or an explicit request) goes into the party hall; everyone
        // else to a table (with the warm size-tiered area offer folded in).
        if (this.isPartyHallBooking()) {
          return this.resume(
            `a group of ${v.partySize} — I'll set you up in our party hall${who} on ${speakDate(v.date!)} at ${speakTime(v.time!)}. Shall I lock that in?`,
            { ackCorrection: correctionAck, question: true },
          );
        }
        const areaClause = this.areaClauseOnce(v.partySize);
        return this.resume(
          `that's a table for ${v.partySize}${who} on ${speakDate(v.date!)} at ${speakTime(v.time!)}.${areaClause} Shall I lock that in?`,
          { ackCorrection: correctionAck, question: true },
        );
      }
      case "ALTERNATIVES_AVAILABLE": {
        const alts = avail.alternatives.slice(0, 2);
        this.pending = { kind: "offer_alternatives", times: alts };
        return this.resume(
          alts.length
            ? `that exact time's taken, but I've got ${alts.map(speakTime).join(" or ")}. Would either suit?`
            : "that time's taken, I'm afraid — is there another time that'd work?",
          { ackCorrection: correctionAck, question: true },
        );
      }
      case "PARTY_TOO_LARGE": {
        this.state.invalidateAvailability();
        this.largePartyTurns++;
        // Parties WITHIN the party hall's capacity are booked directly by
        // toPartyHallConfirmation and never reach here — so this is a group too
        // big even for the hall. One gentle read-back (in case the number was
        // misheard), then a team call-back note. Never loops the "how many" Q.
        if (this.largePartyTurns >= 2) return this.largePartyCallback(v.partySize);
        return this.resume(
          `a group of ${v.partySize} is a really big one — that's beyond what I can set up on the phone, so our team arrange parties that size personally. I'll take your details so they can sort it for you — or if I misheard the number, just say it again.`,
          { question: true },
        );
      }
      case "CLOSED":
        return this.speakClosed(correctionAck);
      default:
        return this.resume(`I couldn't hold that one — shall we try another time?`, { question: true });
    }
  }

  /** CLOSED recovery. The live 4:30 call looped "we're actually closed then, what
   * other day or time?" forever — and because that re-ask names "day", the caller's
   * new TIME got mis-read as a date and never applied. Fix: say WHETHER it's the day
   * or the time, clear the offending field so the next answer re-checks fresh (no
   * stale CLOSED, no per-turn repeat), guide them to the open window, and bound it so
   * a caller is handed to a call-back rather than trapped (Kevin 2026-10-09). */
  private speakClosed(correctionAck = ""): ReservationTurn {
    const v = this.state.values();
    this.state.invalidateAvailability();
    this.closedTurns++;
    // Bounded re-asks of the time — but NEVER hang up (Kevin 2026-10-10). After a few
    // tries, note it for the team and STAY ON THE LINE, offering a different day.
    if (this.closedTurns > 3) {
      const phone = v.phone ?? this.ctx.callerPhone ?? "unknown";
      if (!this.heldForCallback && this.ctx.ownerAlertNumber) {
        this.heldForCallback = true;
        void enqueueNotification(this.ctx.db, {
          orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
          body: `${this.ctx.restaurantName}: table enquiry — couldn't land an open slot by phone${v.name ? ` for ${v.name}` : ""}. Ph ${phone}. Team to call back.`,
        }).catch(() => {});
      }
      this.state.clearField("time");
      return this.holdOpen("I'm having a little trouble finding a time that works — we could try a different day, or I can have the team call you to sort a slot. What would you prefer?", "closed_hold");
    }
    this.phase = "collecting";
    this.pending = { kind: "none" };
    const win = this.dayWindow(v.date);
    if (win && v.date) {
      // The day IS open — the time fell outside our hours. Clear the time and steer
      // them to a workable one; the specific "what time" keeps the next answer a time.
      this.state.clearField("time");
      return this.resume(
        `on ${speakDate(v.date)} we're open from ${speakTime(win.opens)} till ${speakTime(win.closes)} — what time in there would you like?`,
        { ackCorrection: correctionAck, question: true, noAck: true },
      );
    }
    // The whole day is closed — clear the date and ask for another day.
    this.state.clearField("date");
    this.state.clearField("time");
    return this.resume(
      `${v.date ? `we're closed on ${speakDate(v.date)}, I'm afraid` : "we're closed that day, I'm afraid"} — what other day would suit?`,
      { ackCorrection: correctionAck, question: true, noAck: true },
    );
  }

  /** The open window (HH:MM) for a date's day-of-week, or null when that day is
   * closed — used to tell the caller our hours instead of a bare "we're closed". */
  private dayWindow(dateIso?: string): { opens: string; closes: string } | null {
    if (!dateIso) return null;
    const [y, m, d] = dateIso.split("-").map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay();
    const row = this.ctx.hours.find((r) => r.dayOfWeek === dow);
    if (!row || row.isClosed || !row.opensAt || !row.closesAt) return null;
    return { opens: row.opensAt.slice(0, 5), closes: row.closesAt.slice(0, 5) };
  }

  /** The first open day's window — used to answer "when are you open?" before a date
   * is chosen. The venue's daily hours are uniform enough for a helpful answer. */
  private anyOpenWindow(): { opens: string; closes: string } | null {
    const row = this.ctx.hours.find((r) => !r.isClosed && r.opensAt && r.closesAt);
    return row ? { opens: row.opensAt!.slice(0, 5), closes: row.closesAt!.slice(0, 5) } : null;
  }

  // ----------------------------------------------------------------- pending

  private async handlePending(interp: Interpretation, correctionAck: string): Promise<ReservationTurn | null> {
    const p = this.pending;
    // A CORRECTION outranks any pending confirmation (Kevin 2026-10-10 Day 5): the
    // caller changing a value ("no, I said Saturday") is not a yes/no — apply it (done
    // in step 4) and RE-READ the corrected booking, never "what would you like to
    // change?" when they just told us. (spell_name is handled earlier, not here.)
    if (interp.corrections.length && p.kind !== "offer_hold") {
      this.pending = { kind: "none" };
      return this.advance(correctionAck);
    }
    switch (p.kind) {
      case "confirm_booking": {
        if (interp.confirmation && !interp.negation) {
          return this.finaliseBooking();
        }
        if (interp.negation) {
          this.pending = { kind: "none" };
          this.phase = "collecting";
          return this.resume("no problem — what would you like to change?", { question: true });
        }
        return null; // not a yes/no — let advance() re-evaluate (they may have changed a value)
      }
      case "confirm_party": {
        if (interp.confirmation && !interp.negation) {
          this.state.confirmField("partySize");
          this.pending = { kind: "none" };
          return this.advance();
        }
        if (interp.negation) {
          // They said no — the real value should arrive as a correction/entity; if
          // nothing new was captured, re-ask.
          this.pending = { kind: "none" };
          if (this.state.fields.partySize?.turn === this.turn) return this.advance();
          return this.resume("no worries — how many will be dining?", { question: true });
        }
        return null;
      }
      case "confirm_name": {
        if (interp.confirmation && !interp.negation) {
          this.state.confirmField("name");
          this.pending = { kind: "none" };
          return this.advance();
        }
        if (interp.negation) {
          this.pending = { kind: "none" };
          if (this.state.fields.name?.turn === this.turn) return this.advance();
          // The read-back name was wrong → escalate recovery (repeat → spell), never
          // a dead-end re-ask (Kevin 2026-10-10 Day 4).
          this.state.clearField("name");
          return this.nameRecovery();
        }
        return null;
      }
      case "confirm_date": {
        // Grounding the concrete calendar date. Yes → lock it in and move on.
        if (interp.confirmation && !interp.negation) {
          this.state.confirmField("date");
          this.dateNeedsGrounding = false;
          this.pending = { kind: "none" };
          return this.advance();
        }
        // No / a different date → re-collect the day (a new date arriving as an
        // entity/correction this turn is already applied, so just carry on).
        if (interp.negation || this.state.fields.date?.turn === this.turn) {
          this.pending = { kind: "none" };
          this.dateNeedsGrounding = false;
          if (this.state.fields.date?.turn === this.turn) return this.advance();
          this.state.clearField("date");
          return this.resume("no worries — what day would you like instead?", { ackCorrection: correctionAck, question: true });
        }
        return null;
      }
      case "offer_alternatives": {
        // A yes picks the nearest alternative; a specific new time arrives as an entity.
        if (interp.confirmation && !interp.negation && p.times[0]) {
          this.applyAlternative(p.times[0]);
          this.pending = { kind: "none" };
          return this.toConfirmation();
        }
        if (interp.negation && !this.state.fields.time) {
          this.pending = { kind: "none" };
          return this.resume("no worries — what time would you prefer?", { question: true });
        }
        return null;
      }
      case "confirm_cancel": {
        if (interp.confirmation && !interp.negation) {
          this.pending = { kind: "none" };
          return this.doCancel(p.reservationId);
        }
        if (interp.negation) {
          this.pending = { kind: "none" };
          return this.resume("all good — I'll leave that booking as it is. Anything else?", { question: true });
        }
        return null;
      }
      case "offer_hold": {
        this.pending = { kind: "none" };
        return null;
      }
      case "soft_close": {
        // They gave a day/time now → carry on and book it.
        if (this.state.fields.date || this.state.fields.time) { this.pending = { kind: "none" }; return this.advance(); }
        // They want to go ahead but haven't named a day → ask once (keep the beat).
        if (interp.confirmation && !interp.negation) {
          return this.resume(`lovely — what day would suit you?`, { ackCorrection: correctionAck, question: true });
        }
        // Still undecided — STAY ON THE LINE (never hang up); the explicit-end check
        // handles a real "that's all / bye" (Kevin 2026-10-10).
        this.pending = { kind: "none" };
        return this.holdOpen("No worries at all — whenever you settle on the day, just let me know. Is there anything else I can help with in the meantime?", "undecided_hold");
      }
      default:
        return null;
    }
  }

  // ----------------------------------------------------------------- booking

  private async finaliseBooking(): Promise<ReservationTurn> {
    const v = this.state.values();
    const phone = v.phone ?? this.ctx.callerPhone;
    if (!phone) {
      this.pending = { kind: "none" };
      return this.resume("could I grab a mobile number for the booking?", { question: true });
    }
    // Re-check availability if a change slipped in since we last checked (stale
    // guard). For a party-hall booking the check ignores size + main-floor covers
    // but still enforces opening hours / past-date (allowPartyHall).
    const partyHall = this.isPartyHallBooking();
    // Name status for the persisted row: 'unresolved' + staff flag ONLY when we
    // fell back to the caller's number because the name couldn't be captured — never
    // a guessed name (Kevin 2026-10-10 final acceptance).
    const nameStatus: "provided" | "unresolved" = this.nameDeferred ? "unresolved" : "provided";
    const needsStaffAttention = this.nameDeferred;
    let avail = this.state.freshAvailability();
    if (!avail) {
      try {
        avail = await checkAvailability({
          db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
          settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
          date: v.date!, time: v.time!, partySize: v.partySize!,
          allowPartyHall: partyHall,
        });
        this.state.setAvailability(avail);
      } catch {
        return this.resume("I'm having trouble confirming just now — could you bear with me a moment?");
      }
      if (avail.status !== "AVAILABLE") return this.speakAvailability(avail);
    }

    const idempotencyKey = `${this.ctx.callId ?? phone}:${v.date}:${v.time}:${v.partySize}`;
    let created;
    try {
      created = await createReservation(this.ctx.db, {
        restaurantId: this.ctx.restaurantId, customerName: v.name ?? "", customerPhone: phone,
        date: v.date!, time: v.time!, partySize: v.partySize!, source: this.ctx.source ?? "phone",
        callId: this.ctx.callId ?? null, idempotencyKey,
        specialRequests: this.specialRequests(), seatingPref: this.seatingEnum(),
        partyHall, nameStatus, needsStaffAttention,
      });
    } catch (err) {
      if (err instanceof ReservationCapacityError) {
        this.state.invalidateAvailability();
        this.pending = { kind: "none" };
        try {
          const a = await checkAvailability({
            db: this.ctx.db, restaurantId: this.ctx.restaurantId, hours: this.ctx.hours,
            settings: this.ctx.settings, timezone: this.ctx.timezone, now: this.ctx.now(),
            date: v.date!, time: v.time!, partySize: v.partySize!,
            allowPartyHall: partyHall,
          });
          return this.speakAvailability(a.status === "AVAILABLE" ? { status: "ALTERNATIVES_AVAILABLE", alternatives: a.alternatives } : a);
        } catch {
          this.state.fields.time = undefined;
          return this.resume("ah, that spot's just gone — what other time would suit?", { question: true });
        }
      }
      // One safe retry (same idempotency key cannot double-book).
      try {
        created = await createReservation(this.ctx.db, {
          restaurantId: this.ctx.restaurantId, customerName: v.name ?? "", customerPhone: phone,
          date: v.date!, time: v.time!, partySize: v.partySize!, source: this.ctx.source ?? "phone",
          callId: this.ctx.callId ?? null, idempotencyKey,
          specialRequests: this.specialRequests(), seatingPref: this.seatingEnum(),
          partyHall, nameStatus, needsStaffAttention,
        });
      } catch {
        // System error saving the booking — apologise and STAY ON THE LINE with the
        // details held; never hang up (Kevin 2026-10-10).
        if (!this.heldForCallback && this.ctx.ownerAlertNumber) {
          this.heldForCallback = true;
          const vv = this.state.values();
          void enqueueNotification(this.ctx.db, {
            orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
            body: `${this.ctx.restaurantName}: booking SAVE FAILED for ${vv.name ?? "a caller"} ${vv.date ?? ""} ${vv.time ?? ""} party ${vv.partySize ?? "?"}. Ph ${phone}. Needs manual confirm.`,
          }).catch(() => {});
        }
        return this.holdOpen("I'm having a little trouble saving that right this second — I've kept all your details and the team will make sure it's confirmed. Is there anything else I can help with?", "booking_held");
      }
    }

    // CONSISTENCY CHECK — never claim "booked" unless the DB row matches what the
    // caller confirmed (Kevin: no false confirmations).
    const r = created.reservation;
    const mismatches = this.state.consistencyCheck(r);
    if (mismatches.length) {
      this.deps.log?.("consistency-mismatch", { mismatches });
      this.reservation = r;
      this.phase = "confirming";
      this.pending = { kind: "confirm_booking" };
      // Re-sync the state to the DB truth and read THAT back, so we never assert a
      // value that isn't really booked.
      return this.resume(
        `let me just read that back exactly as it's saved: a table for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}${r.customerName ? `, under ${r.customerName}` : ""}. Is that right?`,
        { question: true },
      );
    }

    // DB CONSISTENCY GATE (Kevin 2026-10-10): re-read the row straight from the
    // database and speak/SMS from THAT persisted record — not the conversational
    // state, the LLM, or the INSERT's in-memory copy — so what the caller hears and
    // is texted is exactly what was saved. Falls back to the returned row if the
    // re-read ever fails (never block a real booking on a read).
    const persisted = (await getReservationById(this.ctx.db, r.id).catch(() => null)) ?? r;
    // Unresolved name → alert the team ONCE so a human confirms it (never silently).
    if (persisted.nameStatus === "unresolved" && !this.nameFlagSent && this.ctx.ownerAlertNumber) {
      this.nameFlagSent = true;
      void enqueueNotification(this.ctx.db, {
        orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
        body: `${this.ctx.restaurantName}: NAME UNRESOLVED on booking ${persisted.publicRef} — ${persisted.partySize} on ${speakDate(persisted.reservationDate)} at ${speakTime(persisted.reservationTime.slice(0, 5))}, held under ${persisted.customerPhone}. Please confirm the name.`,
      }).catch(() => {});
    }
    this.reservation = persisted;
    this.state.confirmAll();
    this.extrasDirty = false; // notes were persisted at create via specialRequests()
    this.phase = "booked";
    this.pending = { kind: "none" };
    void this.sendConfirmationSms(persisted);
    const r2 = persisted;
    const who = r2.customerName && r2.customerName !== "Guest" ? `, ${r2.customerName}` : "";
    // Consume any pending lead (e.g. a party-hall acknowledgement set this very turn
    // when the caller asked for it in the same breath as confirming) so it's spoken
    // and never lost. If the lead didn't already cover the party hall, mention it.
    const lead = this.turnLead.trim(); this.turnLead = "";
    const hallNote = this.isPartyHallBooking() && !/party hall/i.test(lead)
      ? " I've noted the party hall for your group." : "";
    return this.emit(
      `${lead ? lead + " " : ""}That's all booked in${who}.${hallNote} I'll send a quick text to confirm. Anything else I can help with?`,
      "confirmed",
    );
  }

  private async sendConfirmationSms(r: Reservation): Promise<void> {
    if (!this.ctx.customerSmsEnabled || !r.customerPhone.startsWith("+")) return;
    const body = `${this.ctx.restaurantName}: booking confirmed for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}${r.customerName ? `, under ${r.customerName}` : ""}. Ref ${r.publicRef}.`;
    // Debounce: only text when the booking's CONTENT actually changed since the last
    // text, so a post-confirmation tweak sends ONE updated confirmation, never a flurry
    // of identical ones (Kevin 2026-10-10: the SMS must track the final record, not spam).
    if (body === this.lastSmsBody) return;
    this.lastSmsBody = body;
    try {
      await enqueueNotification(this.ctx.db, { orderId: null, kind: "customer_sms", toNumber: r.customerPhone, body });
    } catch { /* best-effort */ }
  }

  // ----------------------------------------------------------------- cancel / modify existing

  private async handleCancelIntent(): Promise<ReservationTurn | null> {
    // Cancelling the booking we made THIS call.
    if (this.reservation) {
      this.pending = { kind: "confirm_cancel", reservationId: this.reservation.id };
      return this.resume(`just to confirm — you'd like me to cancel your booking on ${speakDate(this.reservation.reservationDate)} at ${speakTime(this.reservation.reservationTime.slice(0, 5))}?`, { question: true });
    }
    // Cancelling an existing booking on the caller's number.
    const phone = this.ctx.callerPhone;
    if (!phone) return this.resume("I can help with that — what's the mobile number the booking's under?", { question: true });
    let found: Reservation[] = [];
    try { found = await findReservations(this.ctx.db, this.ctx.restaurantId, phone); } catch { /* fallthrough */ }
    if (!found.length) return this.resume("I can't see a booking under this number, I'm afraid — would you like to make one?", { question: true });
    const r = found[0]!;
    this.pending = { kind: "confirm_cancel", reservationId: r.id };
    return this.resume(`I can see your booking for ${r.partySize} on ${speakDate(r.reservationDate)} at ${speakTime(r.reservationTime.slice(0, 5))}. Shall I cancel it?`, { question: true });
  }

  private async doCancel(reservationId: string): Promise<ReservationTurn> {
    let cancelled: Reservation | null = null;
    try { cancelled = await cancelReservation(this.ctx.db, reservationId); } catch {
      // Cancel hit a system error — STAY ON THE LINE (never hang up); the team will
      // action it (Kevin 2026-10-10).
      return this.holdOpen("I'll make sure the team cancels that for you. Is there anything else I can help with?", "cancel_held");
    }
    if (this.reservation?.id === reservationId) this.reservation = null;
    this.phase = "booked"; // stay on the line for anything else
    return this.emit(cancelled ? "Done — that booking's cancelled. Anything else?" : "That one's already cancelled. Anything else?", "cancelled");
  }

  private applyAlternative(time: string): void {
    // Set the chosen alternative as the time (a correction so it supersedes + invalidates).
    this.state.apply(
      { ...emptyInterp(), corrections: [{ field: "time", phrase: time, confidence: 0.95 }] },
      `chose ${time}`, this.turn,
    );
  }

  // ----------------------------------------------------------------- signals

  private handleAbandon(): ReservationTurn {
    this.phase = "ended";
    if (this.reservation) void cancelReservation(this.ctx.db, this.reservation.id).catch(() => {});
    this.reservation = null;
    return this.emit("No problem at all — I won't book anything. Thanks for calling, take care!", "abandoned", true);
  }

  private handleWait(): ReservationTurn {
    this.answeredSomething = true; // holding for the caller is not a stall
    this.holdCount++;
    if (this.holdCount >= 2) {
      return this.resume("no rush at all — would you like me to take your number and have the team call you back instead?", { question: true });
    }
    return this.emit(pick(["Of course — take your time, I'm right here.", "No worries, I'll wait."]), "hold");
  }

  // ----------------------------------------------------------------- questions / info

  /** Factual visiting info only — never invented (spec). Unknowns get an honest
   * offer to have the team confirm, so the question is still acknowledged. */
  private answerQuestion(q: string): string {
    const t = q.toLowerCase();
    this.answeredRealQuestion = true; // set false only on the genuinely-unanswerable fallback
    // "What areas/spaces/seating are available?" — LIST the real options rather than
    // deflect (Kevin 2026-10-09: a caller asked twice and got a generic "I'll note it").
    if (/\b(area|areas|space|spaces|section|sections|seating|spot|spots|room|rooms|hall|where.*sit|sit.*where)\b/.test(t)) {
      const p = this.state.fields.partySize?.value;
      const hall = !p || p >= 6 ? ", or our party hall for a bigger group" : "";
      return `We've got window tables, cosy booths, quieter corners, and some outdoor seating${hall} — is there one you'd like, or shall I pick a lovely spot?`;
    }
    if (/\b(where|located|location|address|find you|get to you|parking|park)\b/.test(t)) {
      if (/\b(park|parking)\b/.test(t)) {
        return this.ctx.address
          ? `We're at ${this.ctx.address} — the team can point you to the nearest parking when you arrive.`
          : "I'm not certain on parking, but the team can let you know when you arrive.";
      }
      return this.ctx.address ? `We're at ${this.ctx.address}.` : "I can have the team text you the address.";
    }
    if (/\b(open|hours|close|closing|what time)\b/.test(t)) {
      // Actually STATE the hours (we have them) rather than deflect — a deflection read
      // as an ignored question and looped on a live call (Kevin 2026-10-10).
      const win = this.dayWindow(this.state.fields.date?.value) ?? this.anyOpenWindow();
      return win
        ? `We're open from ${speakTime(win.opens)} till ${speakTime(win.closes)}. What time would suit you?`
        : "We take bookings across our opening hours — tell me the day and time you'd like and I'll check it for you.";
    }
    if (/\b(how many|party|group|big|large|maximum|max)\b/.test(t)) {
      return `We can usually seat up to ${this.ctx.settings.maxPartySize} on a phone booking — larger than that the team arranges directly.`;
    }
    if (/\b(phone|number|call you|contact)\b/.test(t) && this.ctx.phoneDisplay) {
      return `You can reach us on ${this.ctx.phoneDisplay}.`;
    }
    // DIETARY / allergy — we can't speak for the kitchen, but we CAN note it so it's
    // ready (honest: we note the need, we don't claim a capability we can't verify).
    if (/\b(allerg|gluten|coeliac|celiac|vegan|vegetarian|veggie|dairy|lactose|\bnut\b|nuts|halal|kosher|dietary|intoleran|shellfish|shrimp|seafood)\b/.test(t)) {
      return "I can note any dietary needs for the kitchen — just tell me and I'll add it to the booking.";
    }
    // Little ones / high chair.
    if (/\b(high ?chair|highchair|kids?|child|children|baby|babies|toddler|pram|stroller|booster)\b/.test(t)) {
      return "No trouble — I'll note that on the booking so the team can set you up. Anything else to add?";
    }
    // Accessibility.
    if (/\b(wheelchair|accessib|disabled|ramp|step[- ]?free|mobility)\b/.test(t)) {
      return "I'll note you'd like accessible seating and the team will make sure that's sorted.";
    }
    // Bringing a cake / celebration extras.
    if (/\b(cake|candles?|balloons?|decorat|surprise)\b/.test(t)) {
      return "Lovely — I'll note that on the booking so the team can help with it.";
    }
    // Pricing.
    if (/\b(price|cost|how much|expensive|cheap|per head|per person|set menu)\b/.test(t)) {
      return "I handle the bookings on this line — the team can talk you through pricing when they're in touch.";
    }
    if (/\b(menu|food|dish|serve)\b/.test(t)) {
      return "I handle the table bookings on this line — the team can talk you through the menu when you arrive, and I can note anything important now.";
    }
    // Genuinely unanswerable: warm, honest "the team will sort it". This is the ONLY
    // path that can repeat, so it's bounded — it does NOT count as progress (so the
    // no-progress watchdog ends the call gracefully if a caller only asks unanswerable
    // things), and by the 2nd one it stops offering more Q&A and steers to the booking.
    this.answeredRealQuestion = false;
    this.unanswerableCount++;
    if (this.unanswerableCount >= 2) {
      return "I'll have the team go through all of those details with you when they're in touch — for now, shall I get your table locked in?";
    }
    // VARIED so a caller who asks twice never hears the identical line (natural feel).
    return pick([
      "That's a good one — I'd rather the team give you the exact answer, so I'll flag it for them. In the meantime, let's get your table sorted.",
      "Good question — I'm not totally certain on that, but the team can confirm when they're in touch. Let's lock your booking in first.",
      "I'll make sure the team comes back to you on that one. For now, shall we get your table sorted?",
      "That's best checked with the team, and I'll pass it on — let's get your booking settled in the meantime.",
    ]);
  }

  // ----------------------------------------------------------------- asking

  private askFor(field: string): string {
    switch (field) {
      case "date": return "what day would you like to come in?";
      case "time": return "and what time suits you?";
      case "partySize": return "how many will be dining?";
      case "name": return "and what name should I put it under?";
      case "phone": return "lastly, what's the best mobile number for the booking?";
      default: return "what would you like to do?";
    }
  }

  private async askAboutProblem(p: ResolutionProblem, correctionAck: string): Promise<ReservationTurn> {
    this.clarifyStreak++;
    if (this.clarifyStreak >= MAX_CLARIFY || this.stuck()) {
      // Don't badger — book it if we can, otherwise take a call-back note.
      return this.offerHoldClose();
    }
    switch (p.reason) {
      case "ambiguous_date":
        return this.resume(`did you mean ${p.dateOptions!.slice(0, 2).map((o) => o.label).join(" or ")}?`, { ackCorrection: correctionAck, question: true });
      case "past_date":
        return this.resume("that date's already passed — what day coming up would you like?", { ackCorrection: correctionAck, question: true });
      case "too_far":
        return this.resume("that's a bit further out than we can book right now — is there a nearer date that'd work?", { ackCorrection: correctionAck, question: true });
      case "invalid_date":
        return this.resume("sorry, that date doesn't look quite right — which day did you have in mind?", { ackCorrection: correctionAck, question: true });
      case "ambiguous_time":
        return this.resume(`was that ${p.timeOptions!.slice(0, 2).map((o) => o.label).join(" or ")}?`, { ackCorrection: correctionAck, question: true });
      case "invalid_time":
        return this.resume("sorry, what time were you thinking?", { ackCorrection: correctionAck, question: true });
      case "ambiguous_party":
        return this.resume(`was that ${p.partyOptions!.join(" or ")}?`, { ackCorrection: correctionAck, question: true });
      default:
        return this.resume("sorry, could you say that once more?", { ackCorrection: correctionAck, question: true });
    }
  }

  /** A party beyond even the party hall's capacity (groups within it are booked
   * directly): log a real call-back note for the team and close warmly.
   * Deterministic, single-shot — never a loop (Kevin 2026-10-08: the 17-person
   * call looped "how many can we seat?" and the caller rang off angry). */
  private largePartyCallback(n?: number): ReservationTurn {
    const v = this.state.values();
    const name = v.name && v.name !== "Guest" ? v.name : undefined;
    const phone = v.phone ?? this.ctx.callerPhone ?? "unknown";
    const when = v.date ? ` on ${speakDate(v.date)}${v.time ? ` at ${speakTime(v.time)}` : ""}` : "";
    const extrasNote = this.extras.length ? ` (${[...new Set(this.extras)].join(", ")})` : "";
    if (this.ctx.ownerAlertNumber) {
      void enqueueNotification(this.ctx.db, {
        orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
        body: `${this.ctx.restaurantName}: LARGE-GROUP enquiry — ${name ?? "a caller"}, party of ${n ?? "?"}${when}${extrasNote}. Ph ${phone}. Beyond phone-booking size; team to arrange directly.`,
      }).catch(() => {});
    }
    const who = name ? `, ${name}` : "";
    this.largePartyRouted = true; // don't re-read this line every turn; keep helping
    // STAY ON THE LINE (Kevin 2026-10-10: "do not automatically end the call after
    // large-party routing — only end when the customer is actually finished").
    return this.holdOpen(
      `No problem at all${who} — a group that size the team arranges personally, so I've taken your details and they'll confirm it with you. Is there anything else I can help with, or any questions about it?`,
      "large_party_hold",
    );
  }

  /** Caller hasn't settled on the day (or time): log a brief call-back note AND give
   * ONE soft beat — never a re-ask dance (Kevin 2026-10-08), but never a hard drop
   * either (Kevin 2026-10-09: "if no booking done, give an option — if they suddenly
   * want to book and the call drops it's very bad"). We keep the line open and let
   * them book now if they wish; a second vague reply then ends warmly. */
  private undecidedClose(which: "day" | "time"): ReservationTurn {
    const v = this.state.values();
    const phone = v.phone ?? this.ctx.callerPhone ?? "unknown";
    const known = v.date ? ` for ${speakDate(v.date)}` : "";
    if (this.ctx.ownerAlertNumber) {
      void enqueueNotification(this.ctx.db, {
        orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
        body: `${this.ctx.restaurantName}: table enquiry — caller hasn't settled on a ${which}${known}. Ph ${phone}. They'll call back to book.`,
      }).catch(() => {});
    }
    this.softCloseOffered = true;
    this.pending = { kind: "soft_close", which };
    return this.emit(
      `No worries at all — whenever you settle on the ${which}, just give us a quick call back and we'll sort it. Is there anything else I can help with, or shall I pop a booking in for you now?`,
      "undecided_offer",
      false,
    );
  }

  private async offerHoldClose(): Promise<ReservationTurn> {
    // ABSOLUTE NO-HANG-UP POLICY (Kevin 2026-10-10): this is a "we're stuck" path, and
    // being stuck NEVER ends the call. Either book what we safely can, or keep the
    // line open and keep helping. The caller ends the call, not us.
    if (this.reservation) {
      return this.holdOpen("You're all set. Is there anything else I can help with?", "post_confirm_hold");
    }
    // JUST BOOK IT if we actually can (day + time + party + a number) — a garbled name
    // is not a reason to lose the booking (Kevin 2026-10-09). But NEVER book a nameless
    // reservation silently: if the name is the only thing still unresolved, go through
    // deferName first (honest "I've got your number, I'll flag the name for the team"
    // line + name_status=unresolved + staff flag), never a guessed or empty-and-hidden
    // name (Kevin 2026-10-10 final acceptance). Once deferred, booking proceeds.
    const phoneForBooking = this.state.values().phone ?? this.ctx.callerPhone;
    if (this.state.hasSlot() && phoneForBooking) {
      if (!this.state.values().name && !this.nameDeferred) return await this.deferName(true);
      return this.finaliseBooking();
    }
    // Can't book yet (a core detail is still missing). Note it for the team ONCE, but
    // STAY ON THE LINE and keep helping — never a hang-up.
    const v = this.state.values();
    if (!this.heldForCallback && this.ctx.ownerAlertNumber) {
      this.heldForCallback = true;
      const name = v.name ?? "a caller";
      const phone = v.phone ?? this.ctx.callerPhone ?? "unknown";
      void enqueueNotification(this.ctx.db, {
        orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
        body: `${this.ctx.restaurantName}: table call-back — ${name} is mid-booking but we couldn't settle all the details by phone. Ph ${phone}.`,
      }).catch(() => {});
    }
    const missing = this.state.nextMissing({ needPhone: this.needPhone() });
    const ask = missing ? `Whenever you're ready, ${lowerFirst(this.askFor(missing))}` : "Is there anything else I can help with?";
    return this.holdOpen(`No rush at all — I've kept everything you've given me so far. ${ask}`, "hold_open");
  }

  /** STAY ON THE LINE. The assistant NEVER hangs up on a stuck/unclear/odd turn — it
   * says one honest line and waits for the caller (Kevin 2026-10-10 absolute no-hang-up
   * policy). Resets the loop/stuck counters so a graceful hold can't instantly
   * re-trigger, and leaves the phase live so the next turn is handled normally. */
  private holdOpen(say: string, kind: string): ReservationTurn {
    this.noProgress = 0;
    this.sameQuestionStreak = 0;
    this.closedTurns = 0;
    this.degradedStreak = 0;
    if (this.phase !== "booked" && this.phase !== "confirming") this.phase = "collecting";
    return this.emit(say, kind, false);
  }

  /** The ONE place a call ends on the assistant's side: the caller has clearly
   * finished. Warm, short, and final. */
  private endWarmly(): ReservationTurn {
    this.phase = "ended";
    if (this.reservation) {
      return this.emit(pick(["Lovely — you're all set, thanks so much for calling and we'll see you soon!", "You're all booked — thanks for calling, see you then!"]), "goodbye", true);
    }
    return this.emit(pick(["No worries at all — give us a call whenever you're ready. Thanks for calling!", "No problem — we're here whenever you'd like to book. Thanks so much for calling!"]), "goodbye", true);
  }

  // ----------------------------------------------------------------- response planner

  /**
   * Compose the spoken line: an optional lead (answer / correction ack / read-back),
   * a warm varied acknowledgement, then the next ask. Kept to 1–2 sentences so the
   * assistant stays brisk and human, not a monologue.
   */
  private resume(
    body: string,
    opts: { lead?: string; ackCorrection?: string; question?: boolean; noAck?: boolean } = {},
  ): ReservationTurn {
    const parts: string[] = [];
    // The per-turn lead (an answer to their question / correction ack) comes first,
    // so the caller always hears their point addressed BEFORE we carry on.
    const lead = this.turnLead.trim();
    this.turnLead = "";
    if (lead) parts.push(lead.endsWith(".") || lead.endsWith("!") || lead.endsWith("?") ? lead : `${lead}.`);
    if (opts.lead) parts.push(opts.lead.trim());
    if (opts.ackCorrection) parts.push(`${opts.ackCorrection}.`);
    if (body) {
      // A warm ack only when we're moving the booking forward with nothing already
      // leading the line (an answer/ack/read-back carries its own tone). Vary the
      // structure (and sometimes drop the ack) so it never sounds like a form.
      // Never put a cheerful ack in front of an apology/re-ask ("Brilliant — sorry,
      // could you say that again?" is jarring; Kevin 2026-10-09, natural feel).
      const apologetic = /^\s*(sorry|apolog|no worries,? i didn)/i.test(body);
      const needAck = opts.question && !lead && !opts.lead && !opts.ackCorrection && !apologetic && !opts.noAck;
      parts.push(needAck ? this.warmAck(body) : capFirst(body));
    }
    const say = parts.join(" ").replace(/\s+/g, " ").trim();
    return this.emit(say || "How can I help with your booking?", "reply");
  }

  private readBackSummary(): string {
    const v = this.state.values();
    const bits: string[] = [];
    if (v.partySize) bits.push(`a table for ${v.partySize}`);
    if (v.date) bits.push(`on ${speakDate(v.date)}`);
    if (v.time) bits.push(`at ${speakTime(v.time)}`);
    if (v.name) bits.push(`under ${v.name}`);
    if (!bits.length) return this.lastQuestion || "What would you like to book?";
    // After a booking exists, read it back as confirmed, not "so far I've got".
    return `${this.reservation ? "You're booked in for" : "So far I've got"} ${bits.join(" ")}.`;
  }

  // ----------------------------------------------------------------- helpers

  private emit(say: string, kind: string, endCall = false): ReservationTurn {
    // The line as composed (before any re-ask rewording), for verbatim-repeat detection.
    const incomingNorm = normLine(say);
    const sameFullSay = !endCall && incomingNorm !== "" && incomingNorm === this.lastSayNorm;
    // Extract this line's trailing question up front so the watchdog can tell a
    // FRESH ask from a repeat of the same one.
    let newQuestion = this.lastQuestion;
    if (say.includes("?")) {
      const sentences = say.trim().split(/(?<=[.?!])\s+/);
      const lastQ = [...sentences].reverse().find((s) => s.includes("?"));
      // Strip a leading ack ("Brilliant, what day…") so the stored question is clean —
      // a re-ask/degraded line must not echo "brilliant" inside it (live call 2026-10-09).
      if (lastQ) newQuestion = lastQ.trim().replace(/^(?:lovely|of course|wonderful|no worries|certainly|great|perfect|brilliant)\b[\s,.!—-]+/i, "").trim();
    }
    // No-progress watchdog (the UNIVERSAL loop-breaker — Kevin 2026-10-09 "fix all
    // looping"). A turn is progress ONLY if the booking advanced, or we answered a
    // side-question AND moved on to a DIFFERENT ask. Answering a question while
    // re-asking the IDENTICAL booking question is NOT progress — that exact pattern
    // (an interleaved question resetting the counter every turn) is what let the
    // large-party / CLOSED loops survive. So repeating the same ask always counts
    // toward the stuck ceiling, no matter what else happened on the turn; once it
    // hits STUCK_LIMIT the next advance()/askAboutProblem/degraded check bails to a
    // graceful close or just books (hasSlot) — every call ends, nothing loops.
    const advanced = this.progressSig() !== this.sigAtTurnStart;
    // Is this the SAME question we just asked (ignoring wording/punctuation)?
    const sameQuestion = !endCall && normLine(newQuestion) !== "" && normLine(newQuestion) === normLine(this.lastQuestion);
    if (!endCall) {
      // No-progress watchdog (the UNIVERSAL loop-breaker). A turn is progress ONLY
      // if the booking advanced, or we answered a side-question AND moved on to a
      // DIFFERENT ask. Re-asking the IDENTICAL question is never progress — the exact
      // pattern (an interleaved answered question resetting the counter every turn)
      // that let the large-party / CLOSED loops survive. So a repeat always counts
      // toward the stuck ceiling; the next advance()/askAboutProblem/degraded check
      // then bails to a graceful close or just books — every call ends, nothing loops.
      const progressed = advanced || (this.answeredSomething && !sameQuestion);
      this.noProgress = progressed ? 0 : this.noProgress + 1;
      this.sameQuestionStreak = sameQuestion && !advanced ? this.sameQuestionStreak + 1 : 0;
    }
    if (say.includes("?")) this.lastQuestion = newQuestion;
    // LAST-RESORT loop net: the same question asked far too many times despite every
    // other guard. We do NOT hang up (Kevin 2026-10-10 absolute no-hang-up) — we note
    // it for the team ONCE, reset the counters, and stay on the line with an honest
    // "let me take a step back" so the caller can rephrase, add detail, or ring off.
    if (!endCall && this.sameQuestionStreak >= HARD_REPEAT_LIMIT) {
      if (!this.heldForCallback && !this.reservation && this.ctx.ownerAlertNumber) {
        this.heldForCallback = true;
        const v = this.state.values();
        void enqueueNotification(this.ctx.db, {
          orderId: null, kind: "owner_sms", toNumber: this.ctx.ownerAlertNumber,
          body: `${this.ctx.restaurantName}: caller stuck on the phone${v.name ? ` for ${v.name}` : ""}. Ph ${v.phone ?? this.ctx.callerPhone ?? "unknown"}.`,
        }).catch(() => {});
      }
      this.sameQuestionStreak = 0;
      this.noProgress = 0;
      const line = "Sorry, I'm having a bit of trouble there — could you say that another way, or let me know if you'd like the team to call you back?";
      this.pushHistory("assistant", line);
      this.lastSayNorm = normLine(line);
      return { say: line, kind: "loop_break_hold", endCall: false };
    }
    // NEVER say the same question twice in a row (Kevin 2026-10-09: "no more looping
    // of questions"). Re-word a repeat with a rotating, varied phrasing so the caller
    // never hears the identical ask again — when the whole line repeats, OR when the
    // same question comes round with only an ack/filler ahead of it (a stray "Perfect."
    // must not defeat the dedup). We do NOT reword when a genuine ANSWER leads the line
    // (different content each turn isn't a loop, and the answer must be kept).
    if (say.includes("?") && (sameFullSay || (sameQuestion && leadIsAckOnly(say, newQuestion)))) {
      const lead = this.reaskLeads[this.reaskIdx++ % this.reaskLeads.length]!;
      say = `${lead} — ${lowerFirst(newQuestion.trim())}`;
    }
    this.lastSayNorm = incomingNorm;
    this.pushHistory("assistant", say);
    if (endCall) this.phase = "ended";
    return { say, kind, endCall };
  }

  /** Note a seating/area preference, occasion, or special/dietary request on the
   * booking. Scans the caller's words AND the interpreter's semantic phrases, so an
   * unusually-worded seating/occasion still lands and a dietary note (reference:
   * "allergic to shrimp, avoid avocado") is never dropped. An anniversary (or
   * engagement/proposal/honeymoon) triggers a one-time romantic-table suggestion. */
  private captureExtras(text: string, interp?: Interpretation): void {
    const before = this.extras.length;
    const scan = [text, interp?.seating_request ?? "", interp?.occasion ?? ""].filter(Boolean).join(" ");
    const seat = detectSeating(scan);
    if (seat && !this.extras.includes(seat)) this.extras.push(seat);
    // A SPECIAL / dietary request (allergy, high chair, cake, accessibility) — capture
    // the caller's note verbatim so the team see it; never silently drop it.
    const special = (interp?.special_request ?? "").trim();
    if (special) {
      const note = special.slice(0, 120);
      if (!this.extras.some((e) => e.toLowerCase() === note.toLowerCase())) {
        this.extras.push(note);
        this.turnLead = `${this.turnLead ? this.turnLead + " " : ""}I've made a note of that.`.trim();
        this.answeredSomething = true;
      }
    }
    // A party-hall / function-room request — note it and acknowledge it out loud,
    // never silently drop it (Kevin 2026-10-09: "can you book a party hall?" was ignored).
    if (/\b(party hall|function (?:room|hall)|private (?:room|hall|dining)|banquet (?:room|hall)?|private function)\b/i.test(scan)) {
      this.explicitHallRequest = true;
      if (!this.extras.includes("party hall")) {
        this.extras.push("party hall");
        this.turnLead = `${this.turnLead ? this.turnLead + " " : ""}Of course — I'll note the party hall for your group.`.trim();
        this.answeredSomething = true;
      }
    }
    const occ = scan.match(/\b(anniversary|engagement|proposal|honeymoon|birthday|graduation|reunion)\b/i);
    if (occ) {
      const o = occ[1]!.toLowerCase();
      if (!this.extras.includes(o)) this.extras.push(o);
      if (!this.offeredSpecialSeating) {
        if (/anniversary|engagement|proposal|honeymoon/.test(o)) {
          this.offeredSpecialSeating = true;
          if (!this.extras.includes("romantic table")) this.extras.push("romantic table");
          this.turnLead = `${this.turnLead ? this.turnLead + " " : ""}For your ${o} I'll note one of our quieter, romantic tables for the two of you.`.trim();
          this.answeredSomething = true;
        } else if (o === "birthday") {
          this.offeredSpecialSeating = true;
          if (!this.extras.includes("nice spot (birthday surprise)")) this.extras.push("nice spot (birthday surprise)");
          this.turnLead = `${this.turnLead ? this.turnLead + " " : ""}For the birthday I'll note one of our nicer spots, a nice touch for a surprise.`.trim();
          this.answeredSomething = true;
        }
      }
    }
    // A note added this turn must be PERSISTED — if the booking already exists, flag it
    // so handleBooked writes it to the DB row and re-syncs the SMS (Kevin 2026-10-10:
    // a birthday/seating mentioned after "booked" was acknowledged but never saved).
    if (this.extras.length > before) this.extrasDirty = true;
  }

  private seatingEnum(): "" | "indoor" | "outdoor" {
    if (this.extras.some((e) => /outdoor/.test(e))) return "outdoor";
    if (this.extras.some((e) => /indoor/.test(e))) return "indoor";
    return "";
  }

  private specialRequests(): string {
    const parts = [...this.extras];
    // Ensure a party-hall booking is tagged even when the hall was auto-assigned
    // for a big group (so the engine excludes it from main-floor covers).
    if (this.isPartyHallBooking() && !parts.some((e) => /party hall/i.test(e))) parts.push("party hall");
    return [...new Set(parts)].join("; ");
  }

  /** A compact signature of how far the booking has advanced. Any captured value,
   * correction (revision bump), confirmation, phase change, pending change, or a
   * created reservation changes it — so the watchdog can tell progress from a stall. */
  private progressSig(): string {
    const f = this.state.fields;
    const rev = (x?: { revision: number; confirmed: boolean }) => (x ? `${x.revision}${x.confirmed ? "c" : ""}` : "-");
    return [this.phase, this.pending.kind, this.reservation?.id ?? "",
      rev(f.date), rev(f.time), rev(f.partySize), rev(f.name), rev(f.phone)].join("|");
  }

  private stuck(): boolean { return this.noProgress >= STUCK_LIMIT; }

  private interpreterInput(utterance: string): InterpreterInput {
    const v = this.state.values();
    return {
      utterance,
      history: this.history.slice(-MAX_HISTORY, -1), // exclude the just-pushed caller line (passed as utterance)
      state: {
        phase: this.phase,
        known: v,
        lastQuestion: this.lastQuestion,
        pendingOperation: this.pendingDescription(),
      },
    };
  }

  private pendingDescription(): string | null {
    switch (this.pending.kind) {
      case "confirm_booking": return "lock in the booking";
      case "confirm_party": return `party size of ${this.pending.value}`;
      case "confirm_name": return `the name ${this.pending.value}`;
      case "confirm_date": return `the date ${this.pending.value}`;
      case "offer_alternatives": return "an alternative time";
      case "confirm_cancel": return "cancel the booking";
      default: return null;
    }
  }

  private pushHistory(role: "assistant" | "caller", text: string): void {
    if (!text) return;
    this.history.push({ role, text });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  /** Human-readable form of a corrected field's value, for a specific correction
   * acknowledgement ("…changed the date to Saturday the 31st of October"). */
  private describeValue(field: FieldName, value: string | number): string {
    if (field === "date") return speakDate(String(value));
    if (field === "time") return speakTime(String(value));
    if (field === "partySize") return `${value}`;
    return String(value);
  }

  /** Today's ISO date in the restaurant's timezone (for date-grounding distance). */
  private todayIso(): string {
    return normaliseDate("today", { now: this.ctx.now(), timezone: this.ctx.timezone, maxAdvanceDays: this.ctx.settings.maxAdvanceDays }).date ?? "";
  }

  private needPhone(): boolean {
    // If we have a caller-ID number we can book without asking; otherwise we need one.
    return !this.ctx.callerPhone;
  }

  private needsPartyConfirm(): boolean {
    const p = this.state.fields.partySize;
    return !!p && p.confidence < 0.6 && !p.confirmed;
  }

  private needsNameConfirm(): boolean {
    const n = this.state.fields.name;
    return !!n && n.confidence < 0.75 && !n.confirmed;
  }

  private lastAskedField(): string | null {
    const q = this.lastQuestion.toLowerCase();
    const hasDate = /\b(day|date)\b/.test(q), hasTime = /\btime\b/.test(q);
    // "what other day or time?" names both — disambiguate by what's still missing
    // (a time if the day's already set), so a time answer isn't mis-read as a date.
    if (hasDate && hasTime) return this.state.fields.date && !this.state.fields.time ? "time" : "date";
    if (hasDate) return "date";
    if (hasTime) return "time";
    if (/how many|dining|party|people/.test(q)) return "partySize";
    if (/name/.test(q)) return "name";
    if (/number|mobile|phone/.test(q)) return "phone";
    return null;
  }

  private ack(): string { return this.acks[this.ackIdx++ % this.acks.length]!; }

  /** Join a warm acknowledgement to the next line with a VARIED structure — and
   * occasionally no ack at all — so the assistant doesn't open every turn with the
   * same "Ack — …" cadence (Kevin 2026-10-08: make it smooth / human). */
  private warmAck(body: string): string {
    const r = Math.random();
    // Lead with NO ack about half the time — a receptionist doesn't open every
    // sentence with a cheerful word (Kevin 2026-10-10 Day 5: calmer, less gushy).
    if (r < 0.5) return capFirst(body);
    const a = this.ack();
    if (r < 0.75) return `${a}, ${body}`;
    return `${a} — ${body}`;
  }

  private phaseAsState(): ReservationDebug["state"] {
    switch (this.phase) {
      case "greeting": return "GREETING";
      case "collecting": return "COLLECT_DATE";
      case "confirming": return "CONFIRM_DETAILS";
      case "booked": return "POST_CONFIRM";
      case "ended": return "END";
      default: return "GREETING";
    }
  }
}

// ----------------------------------------------------------------- utilities

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]!; }

/** Does the utterance carry a booking detail (date/time/party) or occasion signal?
 * Used only at the greeting to decide if a plain "I'd like to book" can skip the LLM.
 * Deliberately inclusive — any hint sends the turn to the interpreter so no detail
 * the caller gave up front is ever missed. */
function hasEntitySignal(text: string): boolean {
  const t = text.toLowerCase();
  return /\d/.test(t) ||
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few|dozen)\b/.test(t) ||
    /\b(today|tonight|tomorrow|weekend|fortnight|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/.test(t) ||
    /\b(pm|a\.?m|o'?clock|noon|midday|midnight|half|quarter|morning|afternoon|evening|night|arvo)\b/.test(t) ||
    /\b(people|person|persons|guests?|pax|party of|table for|of us|anniversary|birthday|engagement|proposal|honeymoon)\b/.test(t);
}

/** The caller is pointing at their own caller-ID number rather than reading one
 * out ("just use the number I'm calling from", "the same number", "this number").
 * Deliberately specific so "my number is 0412…" (a real number) does NOT match. */
function refersToOwnNumber(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\bnumber\b/.test(t)) return false; // must actually be about a phone number
  return /\b(same|this|current)\b[^.?!]{0,20}\bnumber\b/.test(t) ||
    /\bnumber\b[^.?!]{0,24}\b(i'?m|i am|im|you'?re|youre|your)\b[^.?!]{0,16}\b(calling|ringing|phoning|on|see|seeing)\b/.test(t) ||
    /\b(calling|ringing|phoning)\b[^.?!]{0,10}\bfrom\b[^.?!]{0,20}\bnumber\b/.test(t) ||
    /\buse\b[^.?!]{0,14}\b(my|the|this|current)\b[^.?!]{0,12}\bnumber\b/.test(t);
}

/** An EXPLICIT request to stop / give up on the booking. Only these end the call on
 * an ABANDON intent — never an inferred one from gibberish (Kevin 2026-10-10: a
 * mis-heard name was read as abandon and the call was cut). */
function saysAbandon(text: string): boolean {
  return /\b(forget it|forget about it|never ?mind|changed my mind|not interested|leave it|don'?t bother|don'?t worry about it|scrap (?:it|that)|drop it|hang up|cancel the call|stop the call|end the call|i'?ll call (?:back )?later|no thanks?,? bye|bye now|goodbye)\b/i.test(text);
}

/** Does the utterance look like DEGENERATE speech-to-text — a hallucinated
 * repetitive run the line produced from noise (a long/incrementing number sequence,
 * or the same token many times over)? Such output must not be interpreted as a real
 * answer or an abandon (Kevin 2026-10-10: a name came through as "1, 2, 3 … 127"). */
function isDegenerateStt(text: string): boolean {
  const toks = text.trim().split(/[\s,]+/).filter(Boolean);
  if (toks.length < 6) return false;
  const nums = toks.filter((t) => /^\d{1,3}$/.test(t)).map(Number);
  // A clean incrementing/decrementing counting run ("1 2 3 4 5 6 …" — the classic
  // STT noise hallucination). This is the strong signal and the one Kevin hit.
  if (nums.length >= 6) {
    let seq = true;
    for (let i = 1; i < nums.length; i++) if (Math.abs(nums[i]! - nums[i - 1]!) !== 1) { seq = false; break; }
    if (seq) return true;
  }
  // An absurdly long all-numbers run — longer than any phone number, so not a real
  // spoken answer (a 10-ish-digit phone number never trips this).
  if (nums.length >= 15 && nums.length >= toks.length * 0.8) return true;
  // The same one or two tokens repeated over and over.
  if (new Set(toks.map((t) => t.toLowerCase())).size <= 2) return true;
  return false;
}

/** Spoken label for a booking field, for correction acknowledgements. */
function speakField(field: FieldName): string {
  return field === "partySize" ? "party size" : field === "phone" ? "number" : field;
}

/** Did the caller express the date RELATIVELY (weekday / week-count / tomorrow / next
 * / fortnight / month) rather than as an explicit calendar date ("14 November")? A
 * relative far-out date is grounded (read back) before we rely on it (Day 3). */
function looksRelativeDate(phrase: string): boolean {
  return /\b(today|tonight|tomorrow|overmorrow|week|weeks|fortnight|month|months|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|next|following|coming|after|weekend)\b/i.test(phrase);
}

/** A representative opening window in minutes-from-midnight for disambiguating a bare
 * ambiguous spoken hour (close is pushed past 1440 for a past-midnight close). Uses the
 * first open day — the venue's daily window is uniform enough for AM/PM disambiguation,
 * and the availability check still enforces the exact per-day hours. */
function openingWindow(hours: { opensAt: string | null; closesAt: string | null; isClosed: boolean }[]): { openMin: number; closeMin: number } | undefined {
  const toMin = (s: string | null): number | null => {
    if (!s) return null;
    const [h, m] = s.split(":").map(Number);
    return h! * 60 + (m ?? 0);
  };
  for (const row of hours) {
    if (row.isClosed) continue;
    const open = toMin(row.opensAt), close = toMin(row.closesAt);
    if (open == null || close == null) continue;
    return { openMin: open, closeMin: close <= open ? close + 1440 : close };
  }
  return undefined;
}

/** Whole days from ISO date `a` to ISO date `b` (both YYYY-MM-DD). */
function isoDaysBetween(a: string, b: string): number {
  if (!a || !b) return 0;
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86400000);
}

/** An EXPLICIT, unambiguous signal that the CALLER wants to finish the call — the
 * only thing (besides an explicit "forget it" abandon) that ends a call on the
 * assistant's side (Kevin 2026-10-10 absolute no-hang-up). Deliberately strict: bare
 * "no" / "no thanks" are NOT here (they're field answers); only clear closings. */
function saysEndIntent(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(bye|bye bye|goodbye|cheers|ta|see ya|see you)\b/.test(t)) return true;
  if (/^(no[, ]+)?(thanks?|thank you)[, ]+(bye|goodbye|that'?s all|that'?s it)\b/.test(t)) return true;
  // NB: "that's all right" / "that's alright" is a CONFIRMATION ("yes, that's fine"),
  // NOT a close — the negative lookahead stops "that's all" ending the call there
  // (Kevin 2026-10-10: "yes that's all right" at the confirm must book, never hang up).
  return /\b(that'?s (all(?!\s*(?:right|righty|rightie))|it|everything|the lot|all thanks|all for now)|nothing (else|more|further)|i'?m (done|good|all set|finished)|we'?re (done|good|all set|fine|finished)|no that'?s (all|it|everything)|i don'?t want to book|don'?t want to book any ?more|forget (the|this|my) (booking|reservation)|cancel (this|the) call|hang up|that'?ll be all|i'?ll (call|ring) (you )?back later)\b/.test(t);
}

/** A plain closing after a booking ("that's all", "thanks", "we're good"). */
function saysDone(text: string): boolean {
  return /\b(no+|nope|nah|that'?s (?:all|it|everything|great|fine|lovely|perfect)|all (?:good|done|set)|we'?re (?:good|fine|set|done)|that'?ll be all|nothing (?:else|more)|i'?m good|cheers|thanks?(?: you)?|ta)\b/i.test(text)
    && !/\b(change|cancel|also|and|another|instead|move|different|wait)\b/i.test(text);
}
/** Normalise a line for loop-detection comparison: lowercased, punctuation and
 * extra whitespace stripped, so "What time?" and "what time" count as the same. */
function normLine(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

/** Is everything in `say` BEFORE its trailing `question` just an ack / filler (so a
 * repeat is a pure re-ask we can safely re-word), rather than a substantive answer we
 * must keep? Empty lead = yes; an answer sentence = no. */
function leadIsAckOnly(say: string, question: string): boolean {
  const idx = say.lastIndexOf(question);
  if (idx < 0) return false; // can't locate the question — don't risk dropping content
  const lead = say.slice(0, idx).trim();
  if (lead === "") return true;
  return /^(?:(?:lovely|of course|wonderful|no worries|certainly|great|perfect|brilliant|okay|ok|right|sure|alright|so|um|thanks|got it|no problem|sorry,? i think i missed that|let me try that again|no rush at all|just so i get it right|apologies,? one more time|that'?s alright)[\s,.!?—-]*)+$/i.test(lead);
}
function capFirst(s: string): string { return s ? s[0]!.toUpperCase() + s.slice(1) : s; }
function lowerFirst(s: string): string { return s ? s[0]!.toLowerCase() + s.slice(1) : s; }

function emptyInterp(): Interpretation {
  return {
    primary_intent: "PROVIDE_BOOKING_INFORMATION", secondary_intents: [], entities: {},
    corrections: [], customer_question: null, occasion: null, seating_request: null,
    special_request: null, confirmation: false, negation: false,
    request_to_repeat: false, request_to_wait: false, request_to_end_call: false,
    request_to_cancel: false, customer_confused: false, assistant_was_corrected: false,
    frustrated: false, uncertain_fields: [], confidence: 1, requires_clarification: false,
    recommended_action: "", reasoning: "internal",
  };
}
