import type { WebSocket } from "ws";
import {
  appendTranscript,
  buildKeyterms,
  buildMenuCatalog,
  endCall,
  enqueueNotification,
  env,
  getDb,
  getDefaultRestaurant,
  getHours,
  getLastOrderForPhone,
  getOrder,
  getSettings,
  listItems,
  listModifierNames,
  markNeedsReview,
  OrderAgent,
  recordCallEvent,
  ReservationMachine,
  ConversationalReservationBrain,
  getReservationSettings,
  startCall,
  useLlmBrainForCaller,
  type CallOutcome,
  type Llm,
  type ReservationBrain,
} from "@meatbox/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { muLawDecodeSample, muLawEncodeSample, muLawFrameRms } from "./audio";
import { type SallyStream } from "./elevenlabs-stream";
import { activeVoiceId, openStt, openTts, ttsSupportsWarmup, type SttStream } from "./voice-providers";
import { getCachedUlaw, maybeCacheSpoken, forceCacheSpoken } from "./tts-cache";

// Restaurant ambience loop (PCM16 8kHz mono), loaded once and cached. Mixed
// quietly under the AI's voice AND played in the gaps between turns, so the
// line sounds like a real busy takeaway shop instead of a sterile bot. Gated by
// AMBIENCE_MODE (off disables it entirely).
let AMBIENCE: Int16Array | null | undefined;
function ambienceLoop(): Int16Array | null {
  if (AMBIENCE !== undefined) return AMBIENCE;
  AMBIENCE = null;
  try {
    const buf = readFileSync(fileURLToPath(new URL("../../web/public/ambience/room.wav", import.meta.url)));
    let o = 12;
    while (o < buf.length - 8) {
      const id = buf.toString("ascii", o, o + 4);
      const sz = buf.readUInt32LE(o + 4);
      if (id === "data") {
        const pcm = new Int16Array(Math.floor(sz / 2));
        for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(o + 8 + i * 2);
        AMBIENCE = pcm;
        break;
      }
      o += 8 + sz;
    }
  } catch {
    /* no ambience asset -> silent (feature simply off) */
  }
  return AMBIENCE;
}
const AMBIENCE_GAIN = 0.2; // audible background, still well under the voice

// Stands in for `this.speaking` while cached audio plays out, so barge-in
// (which checks `this.speaking`) still interrupts it.
const CACHED_PLAYBACK: SallyStream = {
  speak: async () => undefined,
  abort: () => undefined,
  isDead: () => false,
};

/**
 * One Twilio Media Streams WebSocket = one phone call, fully custom:
 * we own the audio, the endpointing, the STT (Scribe), the brain
 * (OrderAgent + fast-path), and the voice (Sally streaming TTS). This is
 * the pipeline that gives Sally's exact voice at fast-path speed, which
 * Twilio ConversationRelay could not.
 *
 * Twilio protocol: connected -> start -> media(20ms mu-law frames) -> stop.
 * We reply with media events (mu-law) and clear events (barge-in flush).
 */

// --- endpointing / barge-in tuning (telephony 8kHz mu-law) ---
const FRAME_MS = 20;
const SPEECH_RMS = 550; // above this = voice present
// Silence after speech = end of utterance. 300ms was TOO twitchy on real calls
// (2026-09-21): a natural mid-sentence pause ("can I get a... meatbox", "chips
// and... salad") is often 400-600ms, so at 300ms we endpointed early, grabbed a
// FRAGMENT ("can I get a meat-", "I got-", "over"), and replied to it — the caller
// experiences that as being cut off / "it's too fast" AND as mishearing, and the
// fragment then garbles to a slow LLM turn. 700ms sits above the typical
// mid-phrase pause so the caller finishes their thought; the small extra wait
// reads as natural human turn-taking, not lag, and it prevents far worse
// fragment-induced lag downstream. Overridable via env for live tuning.
// Kevin 2026-09-25: "give time to finish, but no big lag after they finish".
// Base wait is a natural beat. RAISED 900→1500 (Kevin 2026-10-09: "so much rush,
// not even giving me time to speak" — on a slower cadence / laggy line, 900ms cut
// him off on a mid-sentence pause, e.g. "7, uh, 9 PM" committed at "7"). The REAL
// anti-cut-off work is endsMidThought() below, which extends to
// ENDPOINT_HESITATION_MS. Env-overridable (box sets ENDPOINT_SILENCE_MS).
const ENDPOINT_SILENCE_MS = Number(process.env.ENDPOINT_SILENCE_MS) || 1500;
// Adaptive endpointing: when the caller trails off MID-THOUGHT — a hesitation
// ("uh…"), a dangling connector ("garlic and…", "make it…"), or a change lead
// ("actually…") — give them extra room to finish CHANGING THEIR MIND instead of
// jumping in and talking over them. Only applies when the tail signals more is
// coming, so a finished phrase still endpoints fast (no added lag). Kevin
// 2026-09-24: curveballs/changes need space or the conversation overlaps.
const ENDPOINT_HESITATION_MS = Number(process.env.ENDPOINT_HESITATION_MS) || 3000;
// Stuck-in-utterance recovery: the VAD commits on TRAILING SILENCE, but line noise
// or room ambience above SPEECH_RMS can keep "voice" true so silence never
// accumulates — the utterance stays open and the caller gets dead air (the ambience
// bed is muted while in-utterance too). Live call 2026-10-05: a "Yes" went
// uncommitted ~14s until the caller said "Hello?" thinking the call had dropped. If
// the STT text stops changing for this long we commit anyway, regardless of energy.
const PARTIAL_STALL_MS = Number(process.env.PARTIAL_STALL_MS) || 2200;
// Bare quantity words that, when they END an utterance mid-order, mean an item
// is still coming ("I'll get TWO…", "gimme THREE…") — hold instead of cutting in.
// Guarded in endsMidThought so a complete qty answer ("make it two", bare "two")
// still endpoints fast.
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "couple", "few", "dozen", "half",
]);
// Leading words that make a trailing number a COMPLETE change/answer, not "more
// coming" ("MAKE it two", "JUST two", "THAT'S three") — don't hold on those.
const QTY_COMPLETE_LEADS = new Set(["make", "change", "just", "only", "that", "thats", "its", "it"]);
const INCOMPLETE_TAIL = new Set([
  // hesitation sounds
  "uh", "uhh", "uhm", "um", "umm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "eh",
  // dangling connectors / articles / prepositions — a list or noun phrase is
  // clearly unfinished ("a couple OF…", "one FOR…", "chuck SOME…", "I'll get TO…")
  "and", "or", "plus", "with", "n", "a", "an", "the", "for", "of", "some", "to",
  "into", "just", "like",
  // trailing time lead-ins — a time is still coming ("tomorrow AT…", "around…",
  // "book it BY…") so don't fast-endpoint on the date/word before it.
  "at", "around", "about", "by",
  // change / continuation / ordering leads — a verb with no object yet
  "actually", "maybe", "make", "change", "swap", "gonna", "wanna", "get", "want",
  "grab", "add", "having", "getting", "gimme", "lemme", "chuck", "throw", "hook",
  "give", "put",
]);
// Two-word tails that signal a change/continuation is mid-flight ("make it…",
// "change it…") where the LAST word alone ("it") is ambiguous vs "that's it".
const INCOMPLETE_TAIL_2 = new Set([
  "make it", "change it", "swap it", "turn it", "make that", "change that",
  "get me", "give me", "i want", "can i", "could i",
]);
// A SHORT utterance that opens a question ("is there…", "do you…", "have you
// got…", "what's…") is clearly unfinished — the caller is mid-question. Waiting
// for the rest stops us cutting across them (live India call: "Is there [any
// salad?]" got cut off by the name re-ask). Complete sentences (>3 words) are
// left alone so a real order still endpoints fast.
const QUESTION_OPENERS = new Set([
  "is", "are", "was", "were", "do", "does", "did", "have", "has", "had",
  "can", "could", "would", "will", "should", "what", "whats", "which", "how",
  "where", "when", "why", "who", "any", "hows",
]);
/** The (committed-ish) partial ends on a word/phrase — or is a short question
 * opener — that signals the caller isn't done. Hold the turn a little longer
 * rather than overlap them. */
export function endsMidThought(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const last = words[words.length - 1]!;
  if (INCOMPLETE_TAIL.has(last)) return true;
  if (words.length >= 2 && INCOMPLETE_TAIL_2.has(words.slice(-2).join(" "))) return true;
  // Trailing bare quantity ("I'll get two…", "can I grab three…") = an item is
  // still coming — hold. But NOT a complete qty change/answer ("make it two",
  // "just two", or a bare "two" answering "how many?").
  if (words.length >= 2 && NUMBER_WORDS.has(last) && !QTY_COMPLETE_LEADS.has(words[0]!)) return true;
  return words.length <= 3 && QUESTION_OPENERS.has(words[0]!);
}

// Barge-in must be the CALLER genuinely talking over us — not the quieter echo
// of our own audio coming back on a two-way line, nor a short noise blip. So it
// needs LOUD (near-end) speech, well above normal detection, SUSTAINED longer.
// (A false barge cuts the greeting and breaks the call — worse than a slightly
// late real barge.)
const BARGE_RMS = 1600; // near-end speech; echo returns attenuated, below this
const BARGE_SPEECH_MS = 320; // sustained — filters echo bursts and line noise
// After a barge-in, treat the line as active briefly so the silence watchdog can't
// close right after the caller interrupted us (Kevin 2026-10-10: no recent interruption).
const BARGE_SETTLE_MS = 2500;
const MIN_UTTERANCE_MS = 200; // ignore blips shorter than this

// Common first names to bias the STT toward at the name step (a name is
// otherwise unconstrained — the hardest thing to catch on a phone line, and a
// mis-heard name causes re-asks that drag the call out). Owner's name first so
// his own test calls capture it. They sit AFTER the menu vocabulary in the
// keyterm order, so the menu still gets its slots; these fill the rest ahead of
// alias spellings.
const COMMON_FIRST_NAMES = [
  "Kevin", "David", "John", "Michael", "James", "Daniel", "Sam", "Ben",
  "Chris", "Luke", "Jack", "Ryan", "Josh", "Matt", "Tom", "Nick",
  "Sarah", "Emma", "Zoe", "Jess", "Emily", "Sophie", "Olivia", "Kate",
];

// Idle watchdog. If the caller falls silent — or their mobile uplink drops
// mid-call (live AU call 2026-09-21: dead air after "Coke flavour?") — never sit
// in silence: nudge once or twice, then bow out politely so the call can't hang.
const IDLE_NUDGE_MS = Number(process.env.IDLE_NUDGE_MS) || 9000;
const IDLE_MAX_NUDGES = 2;
// When the CALLER explicitly asks us to wait ("hold on", "give me a sec"), a
// human receptionist waits comfortably instead of nagging 9s later ("Take your
// time" fired, then re-asked while I was still finding my card" — the rushing
// complaint). For this grace window the idle watchdog stays silent; afterwards
// the normal silence cadence resumes, so a caller who truly vanished is still
// caught by the two-nudge bow-out and the line never hangs in dead air.
const WAIT_GRACE_MS = Number(process.env.WAIT_GRACE_MS) || 25000;
// Short, plain fillers spoken on a GENUINE LLM turn (novel/garbled speech) so
// the ~1-2s think isn't dead air (owner chose filler over silence 2026-09-19).
// RARE now — ordering, options, drinks, swaps, changes, removals, cancels,
// item-family clarifies and the name step are all deterministic — so they don't
// repeat like the old "one sec" did when everything hit the brain. Rotated so
// two back-to-back never say the identical phrase. Warmed at boot.
export const AI_FILLERS = ["One moment.", "Just a sec.", "Hang on."];
let fillerRotation = 0;
function nextFiller(): string {
  return AI_FILLERS[fillerRotation++ % AI_FILLERS.length]!;
}

// Strip the brain's internal planning/tool narration that must NEVER be spoken
// to the caller ("Now I'll add the items… I'll add them as pending and ask for
// that. Chips and salad, or rice and salad?" — live call 2026-09-22). Drops any
// sentence that reads as the AI narrating its own actions, keeping the real
// customer-facing lines. Never strips to nothing (falls back to the original).
const NARRATION_RE =
  /\b(i'?ll add|i will add|let me add|i'?ll ask|i'?ll set|i'?ll put (?:it|them)|i'?ll go ahead|i'?m going to|i need to (?:add|set|ask)|adding (?:it|them|the item)|as pending|needs? a base choice|so i'?ll|i'?ll mark|i'?ll note|first,? i|let me (?:start|create|get)(?: (?:that|the order|this|it))?(?: (?:started|going|first|in))?|start(?:ing)? the order|let me (?:just )?(?:pull|check) that up|now i'?ll confirm|i'?ll confirm (?:it|that|the order)|let me confirm)\b/i;
export function stripPlanNarration(text: string): string {
  const parts = text.split(/(?<=[.?!])\s+/).filter((p) => p.trim());
  if (parts.length < 2) return text; // single sentence -> nothing to strip safely
  const kept = parts.filter((p) => !NARRATION_RE.test(p));
  const result = kept.join(" ").trim();
  return result.length >= 2 ? result : text; // never strip to nothing
}

// Collapse an immediately-repeated sentence before we speak it — the brain can
// stutter its own question on a garbled turn ("Chips and salad, or rice and
// salad on both? Chips and salad, or rice and salad?" — live India call
// 2026-09-22). Drops an adjacent sentence that repeats the previous one (exact,
// or one contained in the other), keeping the more informative wording.
export function collapseRepeatedSentences(text: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const parts = text.split(/(?<=[.?!])\s+/).filter((p) => p.trim());
  const kept: string[] = [];
  for (const p of parts) {
    const np = norm(p);
    const prev = kept[kept.length - 1];
    if (np && prev) {
      const npv = norm(prev);
      if (npv && (npv === np || npv.includes(np) || np.includes(npv))) {
        if (np.length > npv.length) kept[kept.length - 1] = p; // keep the longer
        continue;
      }
    }
    kept.push(p);
  }
  return kept.join(" ");
}

export interface MediaSessionDeps {
  createLlm: (model: string | undefined) => Llm;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => Date;
  endDelayMs?: number;
}

export class MediaStreamSession {
  private streamSid = "";
  private callId: string | null = null;
  private agent: OrderAgent | null = null;
  private resMachine: ReservationBrain | null = null;
  private scribe: SttStream | null = null;
  private abort: AbortController | null = null;
  private speaking: SallyStream | null = null;
  private warmTts: SallyStream | null = null; // pre-opened at end-of-speech
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private consecutiveMisses = 0;
  // Loop-breaker: how many times in a row the bot has said the SAME reply with
  // NO order progress (a garbled line / an answer that never resolves). Guards
  // against "repeating continuously, no ending" (Kevin 2026-09-25).
  private lastReplyNorm = "";
  private stuckRepeats = 0;
  // Where to SMS the owner when a call is flagged for review (Kevin 2026-09-25:
  // "alert me the instant any call is flagged" — so nothing is silently missed).
  private ownerAlertNumber = "";
  private lastPlayoutEndAt = 0; // epoch ms when the last spoken audio finishes playing
  private ambienceTimer: ReturnType<typeof setInterval> | null = null;
  private ambiencePos = 0; // shared loop cursor for the ambience bed
  private bargeArmed = false; // barge-in disabled during the greeting (never cut it)

  // VAD state
  private speechMs = 0; // accumulated speech in the current utterance
  private silenceMs = 0; // trailing silence after speech
  private inUtterance = false;
  private awaitingReply = false; // a turn is being processed
  private bargeMs = 0; // sustained speech while we're speaking
  private resBarge = false; // caller just talked over us (reservations) -> apologise next
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private commitAt = 0; // when we asked Scribe to finalise (for STT-RTT timing)
  private segmentHandled = false; // this utterance was answered off its partial (skip committed)
  private segmentSeq = 0; // monotonic id per committed utterance (stale-transcript guard)
  private lastPartial = ""; // last STT partial seen (for stuck-utterance recovery)
  private partialStableMs = 0; // how long the STT partial has been unchanged
  // Idle watchdog state.
  private lastActivityAt = Date.now();
  private idleNudges = 0;
  // While > now, the caller asked us to wait — the idle watchdog stays silent
  // (no nudge) until this passes, then the normal silence cadence resumes.
  private waitGraceUntil = 0;
  private lastBargeAt = 0; // when the caller last interrupted us (barge-in)
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  // Set once the closing ("Done… I'll text it through") is delivered: the call
  // is hanging up, so ignore any further caller speech (no new turns) — the line
  // shouldn't answer a stray "thanks, bye" after the order is finished.
  private ending = false;
  // Guards against an STT stall: after we commit an utterance, the committed
  // transcript should return in a few hundred ms. If it hangs (live India call
  // 2026-09-22 saw a 35s stall = dead air), re-prompt instead of sitting silent.
  private sttStallTimer: ReturnType<typeof setTimeout> | null = null;
  // DTMF (keypad) capture — the robust fallback when speech recognition can't
  // catch a number or a phone digit (spec §5). Digits are buffered and flushed
  // as one utterance on '#', or after a short inter-digit pause, so a single
  // "4" and a full "0412345678" both work.
  private dtmfBuffer = "";
  private dtmfTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: MediaSessionDeps,
  ) {
    ws.on("message", (data: Buffer) => {
      void this.onMessage(data).catch((err) =>
        this.deps.log("media message failed", { error: (err as Error).message }),
      );
    });
    ws.on("close", () => void this.onClose().catch(() => undefined));
    ws.on("error", () => void this.onClose().catch(() => undefined));
  }

  private sendMedia(muLaw: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN && this.streamSid) {
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: muLaw.toString("base64") },
        }),
      );
    }
  }

  private sendClear(): void {
    if (this.ws.readyState === this.ws.OPEN && this.streamSid) {
      this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    }
  }

  /** Low restaurant bed played ONLY in the dead gaps — the waiting-for-caller
   * pause and the thinking pause — so the line never sits in silence. It stops
   * the instant WE speak (so its echo can't trip barge-in) AND the instant the
   * CALLER speaks (so their trailing silence still endpoints and their words
   * aren't muddied). That keeps it well clear of the ordering, echo and all. */
  private startAmbience(): void {
    if (env.AMBIENCE_MODE === "off") return;
    const loop = ambienceLoop();
    if (!loop || loop.length === 0) return;
    this.ambienceTimer = setInterval(() => {
      // Guard the whole body: an unexpected throw here (e.g. ws.send racing a
      // socket teardown) would otherwise reach the global uncaughtException
      // handler and process.exit(1), dropping EVERY concurrent call, not just
      // this one (audit 2026-09-24). A single dropped ambience frame is nothing.
      try {
        if (this.closed || this.speaking || this.inUtterance) return;
        const frame = Buffer.allocUnsafe(160); // one 20ms telephony frame
        for (let i = 0; i < 160; i++) {
          const s = Math.round(loop[this.ambiencePos % loop.length]! * AMBIENCE_GAIN);
          frame[i] = muLawEncodeSample(s);
          this.ambiencePos++;
        }
        this.sendMedia(frame);
      } catch {
        /* noop — never let an ambience frame crash the process */
      }
    }, 20);
  }

  private stopAmbience(): void {
    if (this.ambienceTimer) {
      clearInterval(this.ambienceTimer);
      this.ambienceTimer = null;
    }
  }

  /** Send a voice (μ-law) chunk with the ambience bed mixed quietly under it so
   * the shop is audible WHILE Olivia talks too (not just in the gaps). The
   * hardened barge-in (BARGE_RMS) ignores the resulting echo. Plain send when
   * ambience is off/unavailable. */
  private sendVoice(mu: Buffer): void {
    const loop = env.AMBIENCE_MODE === "off" ? null : ambienceLoop();
    if (!loop || loop.length === 0) {
      this.sendMedia(mu);
      return;
    }
    const out = Buffer.allocUnsafe(mu.length);
    for (let i = 0; i < mu.length; i++) {
      const voice = muLawDecodeSample(mu[i]!);
      const amb = Math.round(loop[this.ambiencePos % loop.length]! * AMBIENCE_GAIN);
      this.ambiencePos++;
      let s = voice + amb;
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out[i] = muLawEncodeSample(s);
    }
    this.sendMedia(out);
  }

  private async onMessage(data: Buffer): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.event) {
      case "start":
        await this.handleStart(msg.start as Record<string, unknown>);
        break;
      case "media":
        this.handleMedia((msg.media as { payload: string }).payload);
        break;
      case "dtmf":
        this.handleDtmf((msg.dtmf as { digit?: string })?.digit ?? "");
        break;
      case "stop":
        await this.onClose();
        break;
      default:
        break; // "connected", "mark", etc.
    }
  }

  private async handleStart(start: Record<string, unknown>): Promise<void> {
    const callSid = String(start.callSid ?? "");
    this.streamSid = String(start.streamSid ?? "");
    const custom = (start.customParameters ?? {}) as Record<string, string>;
    const from = custom.from ?? "";

    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const [settings, hours, menuCatalog, items, modifierNames] = await Promise.all([
      getSettings(db, restaurant.id),
      getHours(db, restaurant.id),
      buildMenuCatalog(db, restaurant.id),
      listItems(db, restaurant.id),
      listModifierNames(db, restaurant.id),
    ]);
    // Bias the STT toward this menu's distinctive words (aliases first — the
    // curated variant spellings are the hardest for STT to catch on a poor line).
    // A few common first names lead so name capture ("Kevin") has a fighting
    // chance — though a name can be anything, so the spoken read-back ("for
    // <name>. Confirm?") remains the real correction path for a mis-heard name.
    // Priority order fills the 50 keyterm slots most-important first: the
    // decision/answer words a caller SAYS (chips/rice/bbq + every salad & sauce)
    // and the core item names, THEN names, THEN alias spellings. Answer
    // vocabulary used to sit behind the long alias list and get squeezed out of
    // the budget — the salad/sauce mis-hears on live calls (MB1129).
    const sttKeyterms = buildKeyterms([
      "chips", "rice", "bbq", // short decision words — always biased
      ...modifierNames, // salads + sauces + extras: the answer vocabulary
      ...items.map((i) => i.name), // core item names (kebab, meatbox, falafel…)
      ...COMMON_FIRST_NAMES,
      ...items.flatMap((i) => i.aliases ?? []), // variant spellings fill the rest
    ]);
    const call = await startCall(db, {
      restaurantId: restaurant.id,
      twilioCallSid: callSid || `media-${this.streamSid}`,
      callerNumber: from && !from.startsWith("client:") ? from : "",
    });
    this.callId = call.id;

    this.ownerAlertNumber = settings.ownerSmsNumber || env.OWNER_NOTIFICATION_PHONE || "";
    const reservationMode = env.BUSINESS_MODE === "reservations";
    const callerNum = from && !from.startsWith("client:") ? from : "";

    if (reservationMode) {
      const reservationSettings = await getReservationSettings(db, restaurant.id);
      const resCtx = {
        db,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        hours,
        settings: reservationSettings,
        timezone: restaurant.timezone,
        now: this.deps.now ?? (() => new Date()),
        callerPhone: callerNum || undefined,
        callId: call.id,
        customerSmsEnabled: settings.customerSmsEnabled,
        ownerAlertNumber: this.ownerAlertNumber,
        address: restaurant.address,
        phoneDisplay: restaurant.phoneDisplay,
        source: custom.source || undefined,
      };
      // The LLM brain runs when the global flag is "llm" OR this caller is on the
      // LLM test allowlist (owner test phones) — so real callers can stay on the
      // proven deterministic brain while the new one is validated on test numbers.
      if (useLlmBrainForCaller(callerNum || from)) {
        // Conversational brain: Haiku 4.5 interprets each utterance; the
        // deterministic engine still controls availability + the DB. The LLM
        // client is lazy on the key, so a missing key never stops the call from
        // starting — the interpreter simply degrades to a re-ask.
        const interpreterLlm = this.deps.createLlm("claude-haiku-4-5");
        this.resMachine = ConversationalReservationBrain.fromLlm(
          resCtx,
          interpreterLlm,
          (m, meta) => this.deps.log(m, meta ?? {}),
        );
        this.deps.log("reservation brain", { brain: "llm", model: "claude-haiku-4-5" });
      } else {
        // Deterministic table-reservation brain — no per-turn LLM needed.
        this.resMachine = new ReservationMachine(resCtx);
      }
    } else {
      let llm: Llm;
      try {
        llm = this.deps.createLlm(settings.aiModel || undefined);
      } catch (err) {
        this.deps.log("LLM unavailable", { error: (err as Error).message });
        await this.speak("Sorry, our ordering assistant isn't available right now. Please call back shortly.");
        await endCall(db, call.id, { status: "failed", outcome: "NO_ORDER" });
        return;
      }
      this.agent = new OrderAgent(llm, {
        db,
        restaurant,
        settings,
        hours,
        callId: call.id,
        callerNumber: callerNum || undefined,
        now: this.deps.now ?? (() => new Date()),
        menuCatalog,
      });
      void this.agent.prewarm();
    }

    // Our own STT for the whole call, biased toward the menu vocabulary.
    this.scribe = openStt(
      {
        onCommitted: (text) => this.onCallerUtterance(text),
        onError: (m) => this.deps.log("scribe error", { m }),
      },
      sttKeyterms,
    );

    this.startAmbience(); // restaurant bed from the greeting onward

    // Returning caller with a prior order (matched by caller ID, history on):
    // greet them back and offer "Same as last time?" — one "yep" reorders the
    // lot. New callers get the normal greeting. Never blocks the call on error.
    const recordNotice = env.RECORD_ALL_INBOUND.toLowerCase() === "true";
    let greeting = reservationMode
      ? this.resMachine!.opening({ recordingNotice: recordNotice })
      : settings.aiGreeting;
    if (!reservationMode && this.agent) {
      try {
        if (callerNum) {
          const last = await getLastOrderForPhone(db, restaurant.id, callerNum);
          if (last && last.order.items.length > 0) {
            greeting = "Welcome back to Meat Box! Same as last time?";
            this.agent.state.repeatOffered = true;
            this.agent.state.lastAssistantText = greeting;
          }
        }
      } catch (err) {
        this.deps.log("repeat lookup failed", { error: (err as Error).message });
      }
    }

    // When every inbound call is recorded, open with a brief consent notice
    // (AU: callers must be told a call may be recorded). In reservations mode the
    // notice is already folded into opening(); ordering prepends it here.
    if (recordNotice && !reservationMode) {
      greeting = `Just so you know, this call may be recorded. ${greeting}`;
    }

    // Speak the greeting ourselves (no platform welcome message here). A failure here
    // (DB hiccup on the transcript write, or an ElevenLabs error on the first live
    // greeting synth) must STILL arm barge-in and the idle watchdog — otherwise the
    // call would run deaf, with no interruption and no dead-air recovery, for its whole
    // life (audit 2026-10-07). So the arming is in `finally`.
    try {
      await appendTranscript(db, call.id, {
        role: "assistant",
        text: greeting,
        at: new Date().toISOString(),
      });
      // Force-cache the greeting (it's long, so the normal cache guard skips it): the
      // greeting is fixed, so caching it makes every call after this one start instantly
      // instead of waiting on an ElevenLabs round-trip (start-of-call lag, Kevin 2026-10-07).
      await this.speak(greeting, { cacheFixed: reservationMode });
    } catch (err) {
      this.deps.log("greeting send failed", { error: (err as Error).message });
    } finally {
      this.bargeArmed = true; // greeting delivered — now a real interruption may cut us off
      this.lastActivityAt = Date.now();
      this.startIdleWatch();
    }
  }

  /** Never sit in dead air: nudge the caller after silence, then end politely.
   * Recovers from a mid-call audio drop or a caller who has gone quiet. */
  private startIdleWatch(): void {
    this.idleTimer = setInterval(() => {
     try {
      if (this.closed) return this.clearIdleWatch();
      // Busy = active: we're speaking, a turn is being processed, the caller is
      // mid-utterance, OR a live partial transcript is building (they're talking
      // right now). The partial check stops a silence prompt firing the instant
      // the caller has started answering (Kevin: "Take your time" fired after I'd
      // already responded).
      // `speaking` goes false when we finish SENDING frames, but Twilio keeps
      // playing them out for several more seconds — so also stay "busy" until the
      // audio has actually finished playing. Without this, a long greeting/prompt
      // ate into the 9s window and the watchdog nudged ~1s after the words ended
      // (live call 2026-10-05: greeting + occasion question were each re-asked).
      // SILENCE SAFETY (Kevin 2026-10-10): silence is the ONLY assistant-initiated
      // end, and only after GENUINE prolonged inactivity. Suppress any nudge while
      // ANY sign of life is present — we're speaking or still playing out, a turn is
      // being processed (a booking write counts), the caller is mid-utterance, a live
      // partial transcript is building, they asked us to hold, or they just
      // interrupted us. The clock only advances when the line is truly quiet.
      if (this.silenceGuardActive()) {
        this.lastActivityAt = Date.now();
        return;
      }
      if (Date.now() - this.lastActivityAt < IDLE_NUDGE_MS) return;
      this.lastActivityAt = Date.now();
      // After a booking is confirmed the line stays open for a change/cancel. If
      // the caller has gone quiet they're done — DON'T re-ask "anything else?"
      // (that was the repeated-confirmation complaint). One warm goodbye, hang up,
      // booking stands. Logged as silence_timeout, never abandonment.
      if (this.resMachine && this.resMachine.debug().state === "POST_CONFIRM") {
        this.clearIdleWatch();
        this.ending = true;
        void (async () => {
          await this.logSilenceTimeout("post_confirm_quiet");
          await this.sayAndLog("All booked — see you then. Cheers.");
          const tail = Math.max(300, this.lastPlayoutEndAt - Date.now());
          await new Promise((r) => setTimeout(r, tail + 300));
          await this.finalise(this.resMachine?.reservation ? "ORDER_COMPLETED" : undefined);
          try { this.ws.close(); } catch { /* noop */ }
        })().catch(() => undefined);
        return;
      }
      if (this.idleNudges < IDLE_MAX_NUDGES) {
        this.idleNudges += 1;
        // Cadence: the FIRST recovery is a gentle, CONTEXTUAL re-ask of the current
        // question — never "are you still there?", which reads as impatient. Only the
        // SECOND, later check asks whether they're still on the line.
        let line: string;
        if (this.resMachine) {
          line = this.idleNudges === 1 ? this.resMachine.gentleReprompt() : "Still there?";
        } else {
          line = this.idleNudges === 1 ? "Sorry, are you still there?" : "Still there? What can I get you?";
        }
        void this.sayAndLog(line).catch(() => undefined);
        return;
      }
      // Two gentle checks have gone unanswered. Before ending, HONOUR a multi-step
      // recovery in progress (name spelling / name confirmation) — never end mid-flow;
      // give one more gentle cycle instead (Kevin 2026-10-10 silence rule).
      if (this.resMachine?.midCriticalFlow?.()) {
        void this.sayAndLog(this.resMachine.gentleReprompt()).catch(() => undefined);
        return;
      }
      // Genuinely prolonged silence through the full cadence, every activity signal
      // clear → warm close. This is dead-LINE recovery (a line can't hang open
      // forever), logged separately as silence_timeout — NEVER customer abandonment.
      this.clearIdleWatch();
      this.ending = true;
      void (async () => {
        await this.logSilenceTimeout("no_response");
        await this.sayAndLog("I'll let you go for now. Feel free to call us back when you're ready.");
        const tail = Math.max(300, this.lastPlayoutEndAt - Date.now());
        await new Promise((r) => setTimeout(r, tail + 300));
        await this.finalise(this.resMachine?.reservation ? "ORDER_COMPLETED" : undefined);
        try {
          this.ws.close();
        } catch {
          /* noop */
        }
      })().catch(() => undefined);
     } catch (err) {
       // A phone line must never drop because the idle watchdog threw — survive it.
       this.deps.log("idle watchdog error (survived)", { error: (err as Error).message });
     }
    }, 1000);
  }

  /** Any sign the caller is still engaged — used to suppress silence nudges and to
   * gate the silence close. Covers Kevin's pre-end checklist that the voice layer
   * can observe: voice activity, a building partial transcript, a committed turn /
   * booking write in flight, our own speech / playout, a hold request, and a very
   * recent interruption. */
  private silenceGuardActive(): boolean {
    return (
      Boolean(this.speaking) ||
      this.awaitingReply ||
      this.inUtterance ||
      Date.now() < this.lastPlayoutEndAt ||
      (this.scribe?.peekPartial() ?? "").length > 0 ||
      Date.now() < this.waitGraceUntil ||
      Date.now() - this.lastBargeAt < BARGE_SETTLE_MS
    );
  }

  /** Record a silence-driven end as its OWN event type (never customer abandonment),
   * so these are auditable and distinct from a caller who chose to leave. */
  private async logSilenceTimeout(reason: string): Promise<void> {
    if (!this.callId) return;
    try {
      await recordCallEvent(getDb(), this.callId, "silence_timeout", {
        reason, hadReservation: Boolean(this.resMachine?.reservation), idleNudges: this.idleNudges,
      });
    } catch { /* best-effort */ }
  }

  private clearIdleWatch(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Every 20ms Twilio frame: feed STT + run VAD (endpoint + barge-in). */
  private handleMedia(payloadB64: string): void {
    const mu = Buffer.from(payloadB64, "base64");
    this.scribe?.pushMuLaw(mu);
    const rms = muLawFrameRms(mu);
    const voice = rms > SPEECH_RMS;

    // Barge-in: caller talks LOUDLY over us -> stop. Uses a higher bar than
    // plain voice detection so echo of our own audio / line noise can't trip it.
    // Disarmed during the greeting so it can never be cut off before it lands.
    if (this.speaking) {
      if (this.bargeArmed) {
        this.bargeMs = rms > BARGE_RMS ? this.bargeMs + FRAME_MS : 0;
        if (this.bargeMs >= BARGE_SPEECH_MS) {
          this.deps.log("barge-in");
          this.stopSpeaking();
          this.sendClear();
          this.abort?.abort();
          // The caller talked over us — mark it so an unrecognised overlap gets
          // a "sorry, say that again?" instead of a guess, and so our next reply
          // opens with a brief apology (Kevin: respect them, never talk over).
          if (this.agent) this.agent.state.afterBarge = true;
          this.resBarge = true;
          this.lastBargeAt = Date.now(); // recent interruption → never silence-close right after
        }
      }
      return; // don't endpoint our own audio back
    }

    // Endpointing: accumulate speech, then trailing silence -> commit.
    if (voice) {
      this.speechMs += FRAME_MS;
      this.silenceMs = 0;
      if (this.speechMs >= MIN_UTTERANCE_MS && !this.inUtterance) {
        this.inUtterance = true;
        // Pre-open Sally's socket the INSTANT the caller is clearly speaking,
        // so the ~150-300ms handshake overlaps their speech — not the reply
        // gap. (End-of-speech was too late: the fast-path brain finishes in
        // ~20ms, well before a handshake started only then would complete.)
        if (ttsSupportsWarmup() && !this.warmTts) this.warmTts = openTts();
      }
    } else if (this.inUtterance) {
      this.silenceMs += FRAME_MS;
      // Hold LONGER when the caller trailed off mid-thought/mid-change so we never
      // cut across them; otherwise the tuned base pause (900ms). A faster
      // "complete-answer" path was tried (650ms) but it cut the caller off on
      // natural pauses — reverted 2026-10-03 (Kevin: "not giving time to speak,
      // rude and rush"). 900ms is the sweet spot: not clippy, not gappy.
      const threshold = endsMidThought(this.scribe?.peekPartial() ?? "")
        ? ENDPOINT_HESITATION_MS
        : ENDPOINT_SILENCE_MS;
      if (this.silenceMs >= threshold && !this.awaitingReply && !this.ending) {
        this.commitUtterance();
        return;
      }
    }

    // Stuck-in-utterance recovery (runs whether or not the VAD currently hears
    // voice): if the STT text has stopped changing, commit even though energy is
    // still present — otherwise line noise / ambience holds the utterance open and
    // the caller gets dead air (live call 2026-10-05: "Yes" uncommitted ~14s). The
    // normal trailing-silence path (900ms) still wins for a clean finish, so this
    // only fires when silence never accumulates.
    if (this.inUtterance && !this.awaitingReply && !this.ending) {
      const p = this.scribe?.peekPartial() ?? "";
      if (p && p === this.lastPartial) {
        this.partialStableMs += FRAME_MS;
        if (this.partialStableMs >= PARTIAL_STALL_MS) this.commitUtterance();
      } else {
        this.lastPartial = p;
        this.partialStableMs = 0;
      }
    }
  }

  /** Finalise the current utterance: stop listening, probe the live partial against
   * the fast path NOW (a clean match answers instantly; a miss does nothing and the
   * accurate committed transcript drives the turn ~400ms later), and ask Scribe to
   * commit. Shared by the trailing-silence path and the stuck-utterance recovery. */
  private commitUtterance(): void {
    this.inUtterance = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.partialStableMs = 0;
    this.lastPartial = "";
    this.awaitingReply = true;
    this.segmentHandled = false;
    this.segmentSeq++; // a new utterance — any earlier committed transcript is now stale
    this.commitAt = Date.now();
    this.lastActivityAt = Date.now(); // caller spoke -> reset the idle watchdog
    this.idleNudges = 0;
    const partial = this.scribe?.peekPartial() ?? "";
    this.scribe?.commit(); // -> committed_transcript -> onCommitted -> onCallerUtterance
    this.armSttStall();
    if (partial) this.enqueueTurn(partial, 0, "probe");
  }

  /** Keypad digit from Twilio. The robust fallback for a number/phone the STT
   * can't catch (spec §5). Only the reservation brain uses it. */
  private handleDtmf(digit: string): void {
    if (this.closed || this.ending || !this.resMachine) return;
    const d = digit.trim();
    // Barge over any current prompt so the keypad entry is acted on immediately.
    if (this.speaking) { this.stopSpeaking(); this.sendClear(); }
    this.lastActivityAt = Date.now();
    this.idleNudges = 0;
    if (d === "#") { this.flushDtmf(); return; }
    if (!/^[0-9*]$/.test(d)) return;
    this.dtmfBuffer += d;
    if (this.dtmfTimer) clearTimeout(this.dtmfTimer);
    // A lone digit (party size) flushes quickly; a longer run (a phone number)
    // coalesces until the caller pauses or presses '#'.
    this.dtmfTimer = setTimeout(() => {
      try { this.flushDtmf(); } catch { /* never let a keypad flush crash the process */ }
    }, 1500);
  }

  private flushDtmf(): void {
    if (this.dtmfTimer) { clearTimeout(this.dtmfTimer); this.dtmfTimer = null; }
    const digits = this.dtmfBuffer.replace(/[*#]/g, "");
    this.dtmfBuffer = "";
    if (!digits || this.closed || this.ending || !this.resMachine) return;
    // Only act on the keypad while we're collecting a number or phone — never
    // let a stray press rewrite a date/time.
    const st = this.resMachine.debug().state;
    if (!["COLLECT_PARTY_SIZE", "CONFIRM_PARTY", "COLLECT_PHONE", "ESCALATION"].includes(st)) return;
    this.deps.log("dtmf", { digits: digits.length, state: st });
    this.awaitingReply = true;
    this.segmentHandled = false;
    this.enqueueTurn(digits, 0, "full");
  }

  /** Re-prompt (instead of dead air) if the committed transcript never arrives. */
  private armSttStall(): void {
    if (this.sttStallTimer) clearTimeout(this.sttStallTimer);
    this.sttStallTimer = setTimeout(() => {
     try {
      this.sttStallTimer = null;
      if (this.closed || this.ending || !this.awaitingReply) return;
      // NEVER talk over a caller who is still speaking — if they're mid-utterance or
      // a partial transcript is still building, give them time: wait and re-arm
      // rather than re-prompting into their speech (Kevin 2026-10-07: no overlapping).
      if (this.inUtterance || (this.scribe?.peekPartial() ?? "").length > 0) {
        this.armSttStall();
        return;
      }
      this.deps.log("STT stall — re-prompting", { waitedMs: Date.now() - this.commitAt });
      this.segmentHandled = true; // discard the late transcript if it ever arrives
      this.awaitingReply = false;
      this.lastActivityAt = Date.now();
      const line = this.resMachine
        ? this.resMachine.gentleReprompt()
        : "Sorry, I didn't catch that — could you say that again?";
      void this.sayAndLog(line).catch(() => undefined);
     } catch { /* never let the stall timer crash the process */ }
    }, 6000);
  }

  private clearSttStall(): void {
    if (this.sttStallTimer) {
      clearTimeout(this.sttStallTimer);
      this.sttStallTimer = null;
    }
  }

  private onCallerUtterance(text: string): void {
    this.clearSttStall();
    // The committed (accurate) transcript arrived. Decide whether to run a full turn
    // ON THE TURN QUEUE, so this decision runs AFTER this segment's probe turn (which
    // sets segmentHandled on a clean fast-path hit). Doing it inline raced the probe:
    // if the committed text arrived mid-probe, segmentHandled was still false and we
    // spoke twice; and a boolean couldn't tell a stale old-segment transcript apart
    // from the current one (audit 2026-10-07 — the double/stale-speak overlap).
    const seg = this.segmentSeq; // the utterance this transcript belongs to
    const sttMs = this.commitAt ? Date.now() - this.commitAt : 0;
    this.turnQueue = this.turnQueue
      .then(async () => {
        // A newer utterance has since been committed — this transcript is stale, drop
        // it (the newer segment drives its own turn).
        if (seg !== this.segmentSeq) return;
        // Already answered off the partial (probe hit) — don't answer twice.
        if (this.segmentHandled) { this.segmentHandled = false; return; }
        if (!text.trim() || this.closed || this.ending) { this.awaitingReply = false; return; }
        // awaitingReply stays set across the full turn so a second endpoint can't stack
        // a duplicate during the think; runTurn's finally clears it.
        await this.runTurn(text.trim(), sttMs, "full");
      })
      .catch(() => undefined);
  }

  private enqueueTurn(text: string, sttMs: number, mode: "probe" | "full"): void {
    this.turnQueue = this.turnQueue.then(() => this.runTurn(text, sttMs, mode)).catch(() => undefined);
  }

  private async runTurn(text: string, sttMs: number, mode: "probe" | "full"): Promise<void> {
    if (this.resMachine) return this.runReservationTurn(text, sttMs, mode);
    if (!this.agent || this.closed) return;
    const db = getDb();
    const agentState = this.agent.state;
    const seqBefore = agentState.mutationSeq; // did the ORDER advance this turn?
    this.abort = new AbortController();
    const turnStarted = Date.now();

    let result: Awaited<ReturnType<OrderAgent["handleTurn"]>> | null = null;
    let firedFiller: string | null = null;
    if (mode === "probe") {
      // Fast path only, off the live partial. A miss means "not a clean
      // deterministic turn" — do nothing and let the committed transcript
      // drive a full turn (leave awaitingReply set so no new endpoint fires).
      // This is the ONE path that intentionally keeps awaitingReply set, so it
      // stays OUTSIDE the try/finally below (which always frees the session).
      result = await this.agent.tryFastPathOnly(text, {}, { probe: true });
      if (!result) return;
      this.segmentHandled = true; // committed transcript for this segment will be ignored
    }

    // Everything from here runs inside try/finally: a DB write (appendTranscript
    // / recordCallEvent) or a TTS (speak) throwing mid-turn must NEVER leave
    // awaitingReply stuck true — that wedges the call in permanent dead air (the
    // endpointer's !awaitingReply gate never fires again, the idle watchdog
    // treats it as "active" and never hangs up). Fail soft instead. Audit 2026-09-24.
    try {
      if (mode !== "probe") {
        // Committed transcript. Probe the fast path first (no LLM). If it handles
        // the turn, reply instantly from cache — no filler. If not, this is a
        // genuine AI turn: fire a short plain filler ("One sec.") WHILE Claude
        // thinks, so the ~1.2s isn't dead air, then speak the real reply.
        const fast = await this.agent.tryFastPathOnly(text);
        if (fast) {
          result = fast;
        } else if (env.AI_FILLER !== "off") {
          // Genuine LLM turn (rare, but slow — 2-5s). Fire a SHORT natural filler
          // ("Just a sec.") WHILE the brain thinks so the caller never hears dead
          // air — that silent gap was Kevin's "so much pauses" complaint (AU test
          // 2026-09-25). Default ON now; set AI_FILLER=off to force a silent think.
          firedFiller = nextFiller();
          const fillerPlaying = this.speak(firedFiller);
          let reply = "";
          result = await this.agent.handleTurn(
            text,
            { onText: (tok) => (reply += tok) },
            this.abort.signal,
          );
          if (!result.text && reply.trim()) result = { ...result, text: reply.trim() };
          await fillerPlaying;
        } else {
          // Filler off: reply the instant the brain finishes, no spoken placeholder.
          let reply = "";
          result = await this.agent.handleTurn(
            text,
            { onText: (tok) => (reply += tok) },
            this.abort.signal,
          );
          if (!result.text && reply.trim()) result = { ...result, text: reply.trim() };
        }
      }
      if (!result) return; // defensive: full mode always assigns result
      let speakText = (result.text || "").trim();
      const turnMs = Date.now() - turnStarted;

      // LOOP-BREAKER (Kevin 2026-09-25: "au calls repeating continuously, no
      // endings"). If the bot says the SAME reply again with NO order progress
      // — a garbled line, or an answer that never resolves — it's stuck. After 3
      // such repeats, stop looping: apologise and END the call (flagged for
      // staff) instead of repeating forever. A normal flow never trips this: the
      // reply changes or the order advances (mutationSeq moves) every real turn.
      const replyNorm = speakText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const progressed = agentState.mutationSeq !== seqBefore;
      if (replyNorm && replyNorm === this.lastReplyNorm && !progressed && !result.endCall) {
        this.stuckRepeats++;
      } else {
        this.stuckRepeats = 0;
      }
      this.lastReplyNorm = replyNorm;
      let stuckEnd = false;
      if (this.stuckRepeats >= 2) {
        speakText =
          "Sorry, I'm having real trouble hearing you — please try calling back in a moment. Thanks.";
        stuckEnd = true;
        this.stuckRepeats = 0;
      }

      if (this.callId) {
        await appendTranscript(db, this.callId, { role: "caller", text, at: new Date().toISOString() });
        if (firedFiller) {
          await appendTranscript(db, this.callId, {
            role: "assistant",
            text: firedFiller,
            at: new Date().toISOString(),
          });
        }
        if (speakText) {
          await appendTranscript(db, this.callId, {
            role: "assistant",
            text: speakText,
            at: new Date().toISOString(),
          });
        }
        for (const c of result.toolCalls) {
          await recordCallEvent(db, this.callId, "tool_call", { name: c.name, input: c.input, result: c.result });
        }
        if (result.error) await recordCallEvent(db, this.callId, "agent_error", { error: result.error });
      }

      // Speak, capturing Sally's time-to-first-audio, then record the FULL felt
      // gap (STT + brain + first audio) — not just brain time.
      const ttfbMs = !result.interrupted && speakText ? await this.speak(speakText) : null;
      if (this.callId) {
        const feltGapMs = sttMs + turnMs + (ttfbMs ?? 0);
        await recordCallEvent(db, this.callId, feltGapMs > 8000 ? "slow_turn" : "turn_metrics", {
          turnMs,
          sttMs,
          ttfbMs,
          feltGapMs,
          toolCalls: result.toolCalls.length,
          interrupted: result.interrupted,
          fastPath: result.fastPath ?? null,
          assistantWords: speakText ? speakText.split(/\s+/).length : 0,
        });
      }

      if (result.error) this.consecutiveMisses++;
      else if (!result.interrupted) this.consecutiveMisses = 0;

      if (result.endCall || this.consecutiveMisses >= 3 || stuckEnd) {
        const forceReview = this.consecutiveMisses >= 3 || stuckEnd;
        this.ending = true; // closing delivered -> ignore any further caller speech
        this.clearIdleWatch(); // and stop the idle nudges during the hang-up
        // Hang up only AFTER the goodbye has finished playing on the line (the
        // closing carries the ETA in digits so it's never cached and streams
        // live) — plus a small tail. Was a flat 800ms, which cut off the goodbye.
        const tail = this.lastPlayoutEndAt - Date.now();
        const delay = Math.max(this.deps.endDelayMs ?? 800, tail + 500);
        this.endTimer = setTimeout(() => {
          void (async () => {
            await this.finalise(forceReview ? "NEEDS_REVIEW" : undefined);
            try {
              this.ws.close();
            } catch {
              /* noop */
            }
          })().catch(() => undefined);
        }, delay);
      }
    } catch (err) {
      // Turn failed (DB/TTS/brain threw). Log it if we can, then fall through to
      // the finally which frees the session so the caller can be heard again.
      try {
        if (this.callId) {
          await recordCallEvent(db, this.callId, "turn_error", {
            error: String((err as Error)?.message ?? err),
            mode,
          });
        }
      } catch {
        /* the DB is likely what just failed — don't throw from the handler */
      }
    } finally {
      // Reply delivered (or the turn failed) — allow the next utterance to
      // endpoint. (A probe that DIDN'T handle returned early above without
      // reaching here, keeping awaitingReply set so the committed transcript
      // drives the turn instead.)
      this.awaitingReply = false;
    }
  }

  /**
   * Reservation-mode turn: drive the deterministic state machine. No fast-path
   * probe, no LLM filler, no loop-breaker — the machine answers in milliseconds.
   * Self-contained try/finally so awaitingReply is always freed (never wedges).
   */
  private async runReservationTurn(text: string, sttMs: number, mode: "probe" | "full"): Promise<void> {
    if (!this.resMachine || this.closed) return;
    if (mode === "probe") return; // reservations run off the committed transcript only
    if (!text.trim()) {
      // The caller talked over us but we couldn't make out the overlap — never
      // leave them hanging: apologise and hand them the floor (Kevin).
      if (this.resBarge) {
        this.resBarge = false;
        await this.sayAndLog("Sorry — you go ahead, I'm listening.");
      }
      this.awaitingReply = false;
      return;
    }
    const db = getDb();
    this.abort = new AbortController();
    const turnStarted = Date.now();
    const stateBefore = this.resMachine.debug();
    try {
      let turn: { say: string; kind: string; endCall?: boolean };
      try {
        turn = await this.resMachine.next(text);
      } catch (err) {
        if (this.callId) {
          await recordCallEvent(db, this.callId, "turn_error", { error: String((err as Error)?.message ?? err) });
        }
        turn = { say: "Sorry, I didn't catch that — could you say that again?", kind: "error" };
      }
      // The caller talked over us and we DID catch it — open the reply with a brief
      // apology so they feel heard, not steam-rolled (Kevin).
      if (this.resBarge && turn.say) {
        this.resBarge = false;
        turn = { ...turn, say: `Sorry about that — ${turn.say}` };
      }
      const speakText = (turn.say || "").trim();
      // The caller asked us to wait ("hold on a sec"): open a grace window so the
      // idle watchdog doesn't nag them, and reset the nudge count so the first
      // prompt after the wait is the gentle re-ask, never "are you still there?".
      if (turn.kind === "hold") {
        this.waitGraceUntil = Date.now() + WAIT_GRACE_MS;
        this.idleNudges = 0;
      }
      const turnMs = Date.now() - turnStarted;
      const stateAfter = this.resMachine.debug();
      if (this.callId) {
        await appendTranscript(db, this.callId, { role: "caller", text, at: new Date().toISOString() });
        if (speakText) {
          await appendTranscript(db, this.callId, { role: "assistant", text: speakText, at: new Date().toISOString() });
        }
      }
      const ttfbMs = speakText ? await this.speak(speakText) : null;
      if (this.callId) {
        const feltGapMs = sttMs + turnMs + (ttfbMs ?? 0);
        await recordCallEvent(db, this.callId, feltGapMs > 8000 ? "slow_turn" : "turn_metrics", {
          turnMs, sttMs, ttfbMs, feltGapMs, kind: turn.kind,
          assistantWords: speakText ? speakText.split(/\s+/).length : 0,
        });
        // Spec §18: per-turn debug record for diagnosing any future failure.
        // Internal only (call_events), never surfaced to the caller.
        await recordCallEvent(db, this.callId, "res_turn", {
          transcript: text,
          stateBefore: stateBefore.state,
          stateAfter: stateAfter.state,
          draft: stateAfter.draft,
          pendingParty: stateAfter.pendingParty ?? null,
          reasks: stateAfter.reasks,
          kind: turn.kind,
          response: speakText,
          endCall: Boolean(turn.endCall),
        });
      }
      if (turn.endCall) {
        this.ending = true;
        this.clearIdleWatch();
        const outcome: CallOutcome = this.resMachine.reservation ? "ORDER_COMPLETED" : "NO_ORDER";
        const tail = this.lastPlayoutEndAt - Date.now();
        const delay = Math.max(this.deps.endDelayMs ?? 800, tail + 500);
        this.endTimer = setTimeout(() => {
          void (async () => {
            await this.finalise(outcome);
            try { this.ws.close(); } catch { /* noop */ }
          })().catch(() => undefined);
        }, delay);
      }
    } finally {
      this.awaitingReply = false;
    }
  }

  /** Speak a SYSTEM-initiated line (idle nudge, goodbye, stall re-prompt) AND
   * record it in the transcript, so a later review of the call/recording shows
   * everything that was actually said — these lines weren't being logged, which
   * hid repeated prompts from the transcript. */
  private async sayAndLog(line: string): Promise<number | null> {
    if (this.callId) {
      try {
        await appendTranscript(getDb(), this.callId, { role: "assistant", text: line, at: new Date().toISOString() });
      } catch { /* transcript logging is best-effort */ }
    }
    return this.speak(line);
  }

  /**
   * Speak text in Sally's voice; resolves when playback audio is fully sent.
   * Returns time-to-first-audio-chunk in ms (null if no audio was produced).
   */
  private async speak(rawText: string, opts: { cacheFixed?: boolean } = {}): Promise<number | null> {
    const text = collapseRepeatedSentences(stripPlanNarration(rawText));
    this.stopSpeaking();
    this.bargeMs = 0;

    // Cache hit: an invariant fast-path phrase already synthesised in Sally's
    // voice -> replay instantly, no ElevenLabs round-trip (0ms to first audio).
    const cached = getCachedUlaw(activeVoiceId(), text);
    if (cached && cached.length > 0) {
      this.speaking = CACHED_PLAYBACK; // so barge-in can interrupt the playout
      for (let i = 0; i < cached.length; i += 1600) this.sendVoice(cached.subarray(i, i + 1600));
      // mu-law 8kHz = 8000 bytes/sec; hold "speaking" for the playout so a
      // barge-in during it is caught (and flushed via sendClear).
      const playoutMs = Math.ceil(cached.length / 8);
      this.lastPlayoutEndAt = Date.now() + playoutMs;
      // Abortable wait: if a barge-in flips this.speaking off CACHED_PLAYBACK
      // (stopSpeaking nulls it) we must STOP waiting at once so the caller's
      // interruption can endpoint — a fixed setTimeout here made the bot ignore
      // a barge-in over a cached line for its full duration (audit 2026-09-24,
      // the "not giving time to speak / overlap" complaint). 40ms granularity.
      for (let waited = 0; waited < playoutMs; waited += 40) {
        if (this.speaking !== CACHED_PLAYBACK) {
          // Barged-in: the remaining audio was flushed (sendClear), so correct the
          // playout-end to ~now — otherwise the idle watchdog thinks we're still
          // "speaking" and the end-of-call tail over-waits (audit 2026-10-07).
          this.lastPlayoutEndAt = Date.now();
          return 0;
        }
        await new Promise((r) => setTimeout(r, Math.min(40, playoutMs - waited)));
      }
      if (this.speaking === CACHED_PLAYBACK) this.speaking = null;
      return 0;
    }

    // Live synthesis. Use the socket pre-opened when the caller started
    // speaking (its handshake already overlapped their speech); else open
    // fresh (greeting, or if the pre-opened one died before we used it).
    if (this.warmTts?.isDead()) this.warmTts = null;
    const stream = this.warmTts ?? openTts();
    this.warmTts = null;
    this.speaking = stream;
    const start = Date.now();
    let ttfb: number | null = null;
    const chunks: Buffer[] = [];
    await stream.speak(text, (chunk) => {
      if (ttfb === null) ttfb = Date.now() - start;
      chunks.push(chunk);
      this.sendVoice(chunk);
    });
    if (this.speaking === stream) this.speaking = null;
    // When the audio will finish playing out on the caller's line (Twilio plays
    // the streamed bytes in real time): first-byte + the audio's own duration.
    // The end-of-call hangup waits for this so the goodbye isn't cut off.
    const totalMs = Math.ceil(chunks.reduce((n, c) => n + c.length, 0) / 8);
    this.lastPlayoutEndAt = start + (ttfb ?? 0) + totalMs;
    // Cache invariant phrases so the next identical one is instant. A KNOWN-FIXED
    // line (the greeting) is force-cached even though it's long, so call #2 onward
    // plays it instantly — no per-call ElevenLabs round-trip (the start-of-call lag).
    if (chunks.length > 0) {
      const buf = Buffer.concat(chunks);
      if (opts.cacheFixed) forceCacheSpoken(activeVoiceId(), text, buf);
      else maybeCacheSpoken(activeVoiceId(), text, buf);
    }
    return ttfb;
  }

  private stopSpeaking(): void {
    if (this.speaking) {
      this.speaking.abort();
      this.speaking = null;
    }
  }

  private async finalise(forceOutcome?: CallOutcome): Promise<void> {
    this.clearIdleWatch();
    this.clearSttStall();
    if (this.closed) return;
    this.closed = true;
    this.stopAmbience();
    const db = getDb();
    if (!this.callId) return;
    const state = this.agent?.state;
    // If a reservation was actually booked, the call completed an order even when
    // finalise is reached via a bare ws-close (hangup race) with no forced outcome
    // — don't mislabel a real booking as NO_ORDER.
    let outcome: CallOutcome =
      forceOutcome ?? state?.outcome ?? (this.resMachine?.reservation ? "ORDER_COMPLETED" : "NO_ORDER");
    // Reason the call is flagged for staff follow-up (empty = not flagged).
    let flaggedReason = forceOutcome === "NEEDS_REVIEW" ? "the call had trouble and was flagged" : "";
    if (state?.draftOrderId && !state.reviewLinkSent) {
      const order = await getOrder(db, state.draftOrderId);
      if (order && order.status === "draft" && (order.subtotalCents > 0 || order.customerName)) {
        await markNeedsReview(db, order.id, "Call ended before the order was confirmed.");
        if (outcome === "NO_ORDER") outcome = "CALL_DROPPED";
        if (!flaggedReason) flaggedReason = "a customer started an order but didn't confirm it";
      }
    }
    await endCall(db, this.callId, { status: "completed", outcome });
    // Owner alert on a flagged call (Kevin 2026-09-25): queue an owner_sms so
    // the shop is told the instant a call needs follow-up — never silently lost.
    // Goes through the same SMS worker + SMS_MODE gate as every other message
    // (log-mode boxes only log it). Best-effort — a failed alert never breaks
    // call teardown.
    if (flaggedReason && this.ownerAlertNumber) {
      try {
        await enqueueNotification(db, {
          orderId: state?.draftOrderId ?? null,
          kind: "owner_sms",
          toNumber: this.ownerAlertNumber,
          body: `Meatbox: a call was flagged for review — ${flaggedReason}. Check the orders dashboard to follow up.`,
        });
      } catch (err) {
        this.deps.log("owner alert enqueue failed", { error: (err as Error)?.message });
      }
    }
  }

  private async onClose(): Promise<void> {
    // Guard each teardown step individually: a throw in any of them (e.g. a double
    // close where abort()/scribe.close() throws when already closed) must NOT skip
    // finalise(), or the call row is left un-ended with no outcome/owner alert and a
    // timer leaks (audit 2026-10-07).
    try { this.abort?.abort(); } catch { /* already aborted */ }
    try { this.stopSpeaking(); } catch { /* nothing playing */ }
    try { this.warmTts?.abort(); } catch { /* already dead */ }
    this.warmTts = null;
    try { this.scribe?.close(); } catch { /* already closed */ }
    if (this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; }
    if (this.dtmfTimer) { clearTimeout(this.dtmfTimer); this.dtmfTimer = null; } // don't leak the DTMF timer
    await this.finalise();
  }
}
