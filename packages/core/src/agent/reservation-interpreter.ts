import type { Llm, LlmToolDef } from "./llm";

/**
 * THE CONVERSATION INTERPRETER (Kevin 2026-10-08 re-architecture).
 *
 * "AI SHOULD UNDERSTAND. CODE SHOULD CONTROL." This module is the *understand*
 * half. It takes ONE caller utterance — together with the conversation so far
 * and what the booking already knows — and returns a structured interpretation:
 * intent(s), the entities mentioned (as verbatim phrases), explicit corrections,
 * a question that must be answered, and the conversational signals (repeat/wait/
 * confused/frustrated/affirm/negate). It NEVER books, decides availability, or
 * computes a final date/time — those are the deterministic layer's job.
 *
 * Crucially, entities are returned as RAW SPOKEN PHRASES, not resolved values.
 * The interpreter says "the date phrase is 'next month the 14th'"; the
 * deterministic state manager runs the existing, battle-tested normaliseDate /
 * normaliseTime / interpretPartySize parsers on that phrase. This plays to each
 * layer's strength: the LLM segments and attributes the utterance (which clause
 * is the date, which is a correction, is this a question rather than an answer),
 * and the code resolves and validates every value. The LLM cannot hallucinate a
 * wrong ISO date because it never emits one.
 */

export type ReservationIntentKind =
  | "NEW_RESERVATION" // wants to book a table
  | "PROVIDE_BOOKING_INFORMATION" // giving a detail (date/time/party/name/phone)
  | "MODIFY_CURRENT_BOOKING" // change the in-progress booking before it's confirmed
  | "MODIFY_EXISTING_BOOKING" // change a booking already in the system
  | "CANCEL_BOOKING" // cancel a booking (in-progress or existing)
  | "CHECK_AVAILABILITY" // "do you have a table for…"
  | "CORRECT_INFORMATION" // fixing a value they or we got wrong
  | "ASK_QUESTION" // a question we must answer (parking, hours, menu…)
  | "REQUEST_REPEAT" // "say that again", "what did you say"
  | "REQUEST_CLARIFICATION" // they didn't understand us
  | "AFFIRM" // yes / correct / that's right
  | "NEGATE" // no / that's wrong
  | "WAIT" // "hold on", "one sec", talking to someone else
  | "ABANDON" // "forget it", "never mind", hanging up
  | "OUT_OF_SCOPE"; // food order, chit-chat, anything not a reservation

export type BookingField = "date" | "time" | "party_size" | "name" | "phone";

export interface EntityMention {
  /** The raw spoken phrase for this entity, verbatim from THIS utterance:
   * "next month the 14th", "half past seven", "just the two of us", "Joseph".
   * The deterministic layer resolves it — the LLM must not compute the value. */
  phrase: string;
  /** How sure the interpreter is this phrase is really this field (0..1). */
  confidence: number;
}

export interface Correction {
  field: BookingField;
  /** The corrected spoken phrase ("actually make it the 15th" -> "the 15th"). */
  phrase: string;
  confidence: number;
}

export interface Interpretation {
  primary_intent: ReservationIntentKind;
  secondary_intents: ReservationIntentKind[];
  /** Entities mentioned THIS turn, each as a verbatim phrase for the parsers. */
  entities: Partial<Record<BookingField, EntityMention>>;
  /** Explicit changes to a value given earlier — latest correction always wins. */
  corrections: Correction[];
  /** A question we must ANSWER before resuming the booking (verbatim), or null. */
  customer_question: string | null;
  /** Clear yes to what we just asked. */
  confirmation: boolean;
  /** Clear no to what we just asked. */
  negation: boolean;
  request_to_repeat: boolean;
  request_to_wait: boolean;
  /** Caller sounds lost / didn't follow — slow down and clarify. */
  customer_confused: boolean;
  /** Caller is telling US we got something wrong ("no, I didn't say that") —
   * must supersede the stored value immediately. */
  assistant_was_corrected: boolean;
  /** Caller sounds unhappy/impatient — acknowledge once, then fix. */
  frustrated: boolean;
  /** Non-slot details the caller gave, as VERBATIM phrases (null if not mentioned).
   * Captured semantically so unusual phrasings still land (the reference caller's
   * "next to the window" and "allergic to shrimp, avoid avocado"). */
  occasion: string | null; // "my wife's birthday", "our anniversary", "a proposal"
  seating_request: string | null; // "next to the window", "somewhere quiet", "a booth"
  special_request: string | null; // "allergic to shrimp, no avocado", "a high chair"
  /** The caller clearly wants to END THE CALL ("that's all", "bye", "I'm done").
   * Distinct from cancelling a booking. */
  request_to_end_call: boolean;
  /** The caller wants to CANCEL the booking (not merely end the call). */
  request_to_cancel: boolean;
  /** Booking fields the interpreter is UNSURE it heard correctly — the controller
   * should CONFIRM or ask to SPELL these rather than trust them (drives name
   * recovery). A name heard on a noisy line belongs here. */
  uncertain_fields: BookingField[];
  /** Overall confidence in this whole interpretation (0..1). */
  confidence: number;
  /** The interpreter is unsure what the caller means and we should ask. */
  requires_clarification: boolean;
  /** The model's suggested next conversational move — ADVISORY ONLY, for diagnostics
   * and as a hint; the deterministic controller decides and may ignore it. Never a
   * business fact, never spoken verbatim. */
  recommended_action: string;
  /** One-line plain-English read of what the caller wants — diagnostics only,
   * never spoken. */
  reasoning: string;
}

/** A compact snapshot of what the booking already knows, given to the LLM so it
 * can tell a NEW value from a CORRECTION and an answer from a fresh request. */
export interface InterpreterStateView {
  /** Where the dialogue is: "collecting", "confirming", "booked", "modifying". */
  phase: string;
  /** Known fields and whether each is confirmed, in human words for the prompt. */
  known: { date?: string; time?: string; party_size?: number; name?: string; phone?: string };
  /** The exact question we asked last turn (what this utterance *might* answer). */
  lastQuestion: string;
  /** A pending operation awaiting a yes/no ("confirm booking", "confirm cancel"). */
  pendingOperation: string | null;
}

export interface InterpreterInput {
  utterance: string;
  /** Recent turns, oldest-first: role + text. Kept short for latency. */
  history: { role: "assistant" | "caller"; text: string }[];
  state: InterpreterStateView;
}

export interface ReservationInterpreter {
  interpret(input: InterpreterInput, signal?: AbortSignal): Promise<Interpretation>;
}

// ----------------------------------------------------------------- tool schema

const INTENT_VALUES: ReservationIntentKind[] = [
  "NEW_RESERVATION", "PROVIDE_BOOKING_INFORMATION", "MODIFY_CURRENT_BOOKING",
  "MODIFY_EXISTING_BOOKING", "CANCEL_BOOKING", "CHECK_AVAILABILITY",
  "CORRECT_INFORMATION", "ASK_QUESTION", "REQUEST_REPEAT", "REQUEST_CLARIFICATION",
  "AFFIRM", "NEGATE", "WAIT", "ABANDON", "OUT_OF_SCOPE",
];
const FIELD_VALUES: BookingField[] = ["date", "time", "party_size", "name", "phone"];

const entitySchema = {
  type: "object",
  properties: {
    phrase: { type: "string", description: "Verbatim spoken phrase for this field, exactly as the caller said it." },
    confidence: { type: "number", description: "0..1 — how sure this phrase is really this field." },
  },
  required: ["phrase", "confidence"],
  additionalProperties: false,
} as const;

const INTERPRET_TOOL: LlmToolDef = {
  name: "interpret",
  description:
    "Record the structured interpretation of the caller's latest utterance. Call this exactly once.",
  input_schema: {
    type: "object",
    properties: {
      primary_intent: { type: "string", enum: INTENT_VALUES },
      secondary_intents: {
        type: "array",
        items: { type: "string", enum: INTENT_VALUES },
        description: "Any OTHER intents present in the same utterance (empty if just one).",
      },
      entities: {
        type: "object",
        description: "Each booking field the caller mentioned THIS turn, as a verbatim phrase. Omit fields not mentioned.",
        properties: {
          date: entitySchema, time: entitySchema, party_size: entitySchema,
          name: entitySchema, phone: entitySchema,
        },
        additionalProperties: false,
      },
      corrections: {
        type: "array",
        description: "Explicit changes to a value the caller (or we) stated earlier. Latest correction wins.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: FIELD_VALUES },
            phrase: { type: "string", description: "The corrected value as a verbatim phrase." },
            confidence: { type: "number" },
          },
          required: ["field", "phrase", "confidence"],
          additionalProperties: false,
        },
      },
      customer_question: {
        type: ["string", "null"],
        description: "A question we must ANSWER before resuming the booking (parking, hours, menu, location…), verbatim. Null if the caller asked nothing.",
      },
      occasion: { type: ["string", "null"], description: "If the caller mentioned an occasion (birthday, anniversary, engagement, proposal, honeymoon), their verbatim words; else null." },
      seating_request: { type: ["string", "null"], description: "If the caller asked for a particular area/seat (window, booth, quiet, outdoor, party hall), their verbatim words; else null." },
      special_request: { type: ["string", "null"], description: "Any other request to note: dietary/allergy, high chair, accessibility, cake, etc., verbatim; else null." },
      confirmation: { type: "boolean", description: "Clear YES to what we just asked." },
      negation: { type: "boolean", description: "Clear NO to what we just asked." },
      request_to_repeat: { type: "boolean", description: "Caller asked us to repeat / didn't hear us." },
      request_to_wait: { type: "boolean", description: "Caller asked us to hold / is distracted / talking to someone else." },
      request_to_end_call: { type: "boolean", description: "Caller clearly wants to FINISH THE CALL: 'that's all', 'bye', 'nothing else', 'I'm done', 'I don't want to book'. NOT a mere 'no' answer to a question." },
      request_to_cancel: { type: "boolean", description: "Caller wants to CANCEL a booking (not just end the call)." },
      customer_confused: { type: "boolean", description: "Caller sounds lost or didn't follow." },
      assistant_was_corrected: { type: "boolean", description: "Caller is telling US we got a value wrong." },
      frustrated: { type: "boolean", description: "Caller sounds unhappy or impatient." },
      uncertain_fields: {
        type: "array",
        items: { type: "string", enum: FIELD_VALUES },
        description: "Fields you are NOT confident you heard correctly (e.g. a name on a noisy line). The controller will confirm/spell these — so flag an unclear name here rather than guessing it.",
      },
      requires_clarification: { type: "boolean", description: "You cannot tell what the caller means — we should ask." },
      recommended_action: { type: "string", description: "Optional one-line hint for the next move (e.g. 'confirm the name', 'ask the time', 'answer parking then resume'). Advisory only." },
      confidence: { type: "number", description: "0..1 overall confidence in this interpretation." },
    },
    // ONLY primary_intent is required. Every other field is optional and defaults
    // via coercion, so the model emits just what applies — a huge output-token
    // (= latency) saving: a plain answer is ~30 tokens, not ~350.
    required: ["primary_intent"],
    additionalProperties: false,
  },
};

// ----------------------------------------------------------------- system prompt

/** Business framing + the interpreter's contract. Stable per restaurant, so it
 * sits at the cacheable head of every request (cheap + fast across the call). */
export function buildInterpreterSystem(restaurantName: string): string {
  return [
    `You are the LISTENING layer of ${restaurantName}'s phone reservation assistant.`,
    `Your ONLY job is to understand ONE caller utterance and record a structured interpretation by calling the "interpret" tool exactly once. You never speak to the caller and you never book anything.`,
    ``,
    `HOW TO THINK:`,
    `- Treat the utterance as a NEW conversational event, not automatically an answer to the last question. The caller may ignore the question, ask their own, change their mind, or correct something.`,
    `- A correction, a question, or a change OUTRANKS the pending question. If the caller is changing a value or asking something, say so — do not force their words into an answer to what we asked.`,
    `- If the caller states a value they gave before but DIFFERENT, it is a correction (put it in "corrections"), not a fresh entity.`,
    `- If the caller says we got something wrong ("no, I said November", "that's not right"), set assistant_was_corrected true and put the right value (if given) in corrections.`,
    `- Multiple things in one breath ("change it to the 15th and make it 6 people") → fill secondary_intents AND multiple corrections/entities.`,
    `- A question we must answer (parking, hours, menu, where are you) → set customer_question to their words AND set ASK_QUESTION (as primary or secondary).`,
    ``,
    `ENTITIES ARE VERBATIM PHRASES — NOT RESOLVED VALUES.`,
    `- Put the caller's exact words for each field: date "next month the 14th", time "half past seven", party_size "just the two of us", name "Joseph", phone "oh four one two…".`,
    `- NEVER compute a calendar date, a 24-hour time, or a digit count. The deterministic engine does that. You only identify which words are which field.`,
    `- Only include a field the caller actually mentioned this turn.`,
    ``,
    `NON-SLOT DETAILS — capture these by MEANING, not keywords: occasion (birthday/anniversary/engagement/proposal/honeymoon), seating_request (window/booth/quiet/outdoor/party hall), special_request (allergy/dietary, high chair, accessibility, cake). Put the caller's verbatim words; null if not mentioned. These are notes on the booking — they never replace a slot field.`,
    ``,
    `SIGNALS: set confirmation/negation only for a clear yes/no to our last question. request_to_repeat for "say again". request_to_wait for "hold on / one sec / talking to someone". request_to_end_call ONLY for a clear close ("that's all", "bye", "nothing else", "I'm done", "I don't want to book") — NOT a bare "no" answering a question. request_to_cancel when they want to cancel a booking. customer_confused when they sound lost. frustrated when unhappy or impatient. requires_clarification when you genuinely cannot tell what they mean.`,
    ``,
    `UNCERTAINTY: if you are not confident you heard a value right — ESPECIALLY A NAME on a noisy line — put that field in uncertain_fields and still give your best-guess phrase. NEVER invent a name; an unclear name is uncertainty to confirm/spell, not a reason to do anything drastic. Unclear input is NEVER an abandon or an end-call.`,
    ``,
    `BE MINIMAL AND FAST: include ONLY the fields that apply. Omit every boolean that is false, omit entities/corrections that aren't present, omit customer_question when there is none. A plain answer like "seven o'clock" is just primary_intent + one entity. Do not pad the output.`,
    ``,
    `EXAMPLES (the examples are a guide to the KINDS of reasoning, not an exhaustive list — generalise):`,
    `1. We asked the time; caller: "actually let's do six people, and make it Friday". → primary PROVIDE_BOOKING_INFORMATION, secondary [CORRECT_INFORMATION]; entities party_size "six people"; corrections date "Friday" if a date was set before, else entity date "Friday". (They ignored the time question and gave other details — that's fine, capture what they said.)`,
    `2. We asked for the name; caller: "wait, can you change the date to the 14th of November?". → primary MODIFY_CURRENT_BOOKING; corrections date "the 14th of November"; assistant_was_corrected false. (A change OUTRANKS the name question — do NOT read "change the date" as a name.)`,
    `3. We asked the party size; caller: "do you have parking? oh, and four of us". → primary ASK_QUESTION, secondary [PROVIDE_BOOKING_INFORMATION]; customer_question "do you have parking?"; entities party_size "four of us".`,
    `4. We asked to confirm the booking; caller: "no, I said Joseph not Joshua". → primary CORRECT_INFORMATION; corrections name "Joseph"; assistant_was_corrected true; negation true.`,
    `5. We asked the date; caller: "half seven tomorrow for my wife and me". → primary PROVIDE_BOOKING_INFORMATION; entities date "tomorrow", time "half seven", party_size "my wife and me".`,
    `6. We asked the party size; caller: "four, and it's our anniversary — somewhere quiet if you can". → primary PROVIDE_BOOKING_INFORMATION; entities party_size "four"; occasion "our anniversary"; seating_request "somewhere quiet".`,
    `7. We asked for the name; caller (noisy line): "it's… Walza? Walza." → primary PROVIDE_BOOKING_INFORMATION; entities name "Walza" (best guess); uncertain_fields ["name"]. (Flag the name as uncertain so we confirm/spell it — never guess silently, never treat as abandon.)`,
    `8. We asked "anything else before I confirm?"; caller: "no, that's it thanks". → primary NEGATE; request_to_end_call true. (A clear close.)`,
    `9. We asked the time; caller: "no I don't need, uh, I'm allergic to shrimp and no avocado". → primary PROVIDE_BOOKING_INFORMATION; special_request "allergic to shrimp, no avocado". (Capture the dietary note; it is NOT a time and NOT a negation of our question.)`,
    `10. Caller (terse): "five at seven, name Zoe" or "two at eight". → entities party_size "five"/"two", time "seven"/"eight", name "Zoe" when present. (A bare number right before "at <time>" is the PARTY SIZE and the <time> after "at" is the TIME — capture BOTH; never drop the leading number.)`,
    `11. Caller: "three people" (whatever we asked). → entities party_size "three people". And "eight o'clock" → entities time "eight o'clock". (The field is fixed by the WORDS — "people" = party, "o'clock"/am/pm = time — never by which question we asked.)`,
  ].join("\n");
}

function buildTurnMessage(input: InterpreterInput): string {
  const { state, history, utterance } = input;
  const known = Object.entries(state.known)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "nothing yet";
  const hist = history.length
    ? history.map((h) => `${h.role === "assistant" ? "Assistant" : "Caller"}: ${h.text}`).join("\n")
    : "(start of call)";
  return [
    `PHASE: ${state.phase}`,
    `ALREADY KNOWN: ${known}`,
    state.pendingOperation ? `AWAITING YES/NO ON: ${state.pendingOperation}` : ``,
    `WE LAST ASKED: ${state.lastQuestion || "(nothing yet)"}`,
    ``,
    `RECENT CONVERSATION:`,
    hist,
    ``,
    `CALLER JUST SAID: "${utterance}"`,
    ``,
    `Call "interpret" once for this utterance.`,
  ].filter(Boolean).join("\n");
}

// ----------------------------------------------------------------- construction

export interface InterpreterOptions {
  restaurantName: string;
  /** Hard latency ceiling; on timeout the caller falls back to the deterministic
   * brain for that turn so a slow LLM never stalls or drops the call. */
  timeoutMs?: number;
  /** Diagnostics sink (per-turn), never spoken. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** A neutral interpretation used when the LLM is unavailable/times out, so the
 * caller is routed to the deterministic fallback rather than being dropped. */
export function unknownInterpretation(reason: string): Interpretation {
  return {
    primary_intent: "PROVIDE_BOOKING_INFORMATION",
    secondary_intents: [],
    entities: {},
    corrections: [],
    customer_question: null,
    occasion: null,
    seating_request: null,
    special_request: null,
    confirmation: false,
    negation: false,
    request_to_repeat: false,
    request_to_wait: false,
    request_to_end_call: false,
    request_to_cancel: false,
    customer_confused: false,
    assistant_was_corrected: false,
    frustrated: false,
    uncertain_fields: [],
    confidence: 0,
    requires_clarification: true,
    recommended_action: "",
    reasoning: `interpreter-unavailable: ${reason}`,
  };
}

export function createReservationInterpreter(
  llm: Llm,
  opts: InterpreterOptions,
): ReservationInterpreter {
  const system = buildInterpreterSystem(opts.restaurantName);
  const timeoutMs = opts.timeoutMs ?? 1500;

  return {
    async interpret(input: InterpreterInput, signal?: AbortSignal): Promise<Interpretation> {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();
      try {
        let toolInput: Record<string, unknown> | null = null;
        for await (const ev of llm.stream({
          system,
          messages: [{ role: "user", content: buildTurnMessage(input) }],
          tools: [INTERPRET_TOOL],
          toolChoice: { type: "tool", name: "interpret" },
          maxTokens: 500,
          signal: controller.signal,
        })) {
          if (ev.type === "tool_use" && ev.name === "interpret") toolInput = ev.input;
        }
        if (!toolInput) return unknownInterpretation("no-tool-output");
        const parsed = coerceInterpretation(toolInput);
        opts.log?.("interpreter", {
          ms: Date.now() - started,
          intent: parsed.primary_intent,
          secondary: parsed.secondary_intents,
          entities: Object.keys(parsed.entities),
          corrections: parsed.corrections.map((c) => c.field),
          question: parsed.customer_question ? true : false,
          confidence: parsed.confidence,
        });
        return parsed;
      } catch (err) {
        const reason = controller.signal.aborted ? "timeout" : String((err as Error)?.message ?? err);
        opts.log?.("interpreter-error", { ms: Date.now() - started, reason });
        return unknownInterpretation(reason);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ----------------------------------------------------------------- coercion

const asBool = (v: unknown): boolean => v === true;
const asNum = (v: unknown, dflt = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

function asIntent(v: unknown): ReservationIntentKind | null {
  return typeof v === "string" && (INTENT_VALUES as string[]).includes(v) ? (v as ReservationIntentKind) : null;
}

function coerceEntity(v: unknown): EntityMention | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const phrase = asStr(o.phrase).trim();
  if (!phrase) return null;
  return { phrase, confidence: clamp01(asNum(o.confidence, 0.5)) };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Defensive: never trust the model's JSON shape. Coerce to a valid
 * Interpretation, dropping anything malformed, so the controller is total. */
export function coerceInterpretation(raw: Record<string, unknown>): Interpretation {
  const primary = asIntent(raw.primary_intent) ?? "PROVIDE_BOOKING_INFORMATION";
  const secondary = Array.isArray(raw.secondary_intents)
    ? (raw.secondary_intents.map(asIntent).filter(Boolean) as ReservationIntentKind[])
    : [];

  const entities: Partial<Record<BookingField, EntityMention>> = {};
  const rawEnt = (raw.entities && typeof raw.entities === "object" ? raw.entities : {}) as Record<string, unknown>;
  for (const f of FIELD_VALUES) {
    const e = coerceEntity(rawEnt[f]);
    if (e) entities[f] = e;
  }

  const corrections: Correction[] = Array.isArray(raw.corrections)
    ? (raw.corrections
        .map((c): Correction | null => {
          if (!c || typeof c !== "object") return null;
          const o = c as Record<string, unknown>;
          const field = typeof o.field === "string" && (FIELD_VALUES as string[]).includes(o.field)
            ? (o.field as BookingField) : null;
          const phrase = asStr(o.phrase).trim();
          if (!field || !phrase) return null;
          return { field, phrase, confidence: clamp01(asNum(o.confidence, 0.6)) };
        })
        .filter(Boolean) as Correction[])
    : [];

  const q = raw.customer_question;
  const customer_question = typeof q === "string" && q.trim() ? q.trim() : null;
  const asPhraseOrNull = (v: unknown): string | null => {
    const s = asStr(v).trim();
    return s ? s : null;
  };
  const uncertain_fields = Array.isArray(raw.uncertain_fields)
    ? (raw.uncertain_fields.filter((f): f is BookingField => typeof f === "string" && (FIELD_VALUES as string[]).includes(f)))
    : [];

  return {
    primary_intent: primary,
    secondary_intents: secondary,
    entities,
    corrections,
    customer_question,
    occasion: asPhraseOrNull(raw.occasion),
    seating_request: asPhraseOrNull(raw.seating_request),
    special_request: asPhraseOrNull(raw.special_request),
    confirmation: asBool(raw.confirmation),
    negation: asBool(raw.negation),
    request_to_repeat: asBool(raw.request_to_repeat),
    request_to_wait: asBool(raw.request_to_wait),
    request_to_end_call: asBool(raw.request_to_end_call),
    request_to_cancel: asBool(raw.request_to_cancel),
    customer_confused: asBool(raw.customer_confused),
    assistant_was_corrected: asBool(raw.assistant_was_corrected),
    frustrated: asBool(raw.frustrated),
    uncertain_fields,
    confidence: clamp01(asNum(raw.confidence, 0.5)),
    requires_clarification: asBool(raw.requires_clarification),
    recommended_action: asStr(raw.recommended_action),
    reasoning: asStr(raw.reasoning),
  };
}
