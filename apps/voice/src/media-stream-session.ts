import type { WebSocket } from "ws";
import {
  appendTranscript,
  buildMenuCatalog,
  endCall,
  env,
  getDb,
  getDefaultRestaurant,
  getHours,
  getOrder,
  getSettings,
  markNeedsReview,
  OrderAgent,
  recordCallEvent,
  startCall,
  type CallOutcome,
  type Llm,
} from "@meatbox/core";
import { muLawFrameRms } from "./audio";
import { ScribeStream, openSallyStream, type SallyStream } from "./elevenlabs-stream";
import { getCachedUlaw, maybeCacheSpoken } from "./tts-cache";

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
const ENDPOINT_SILENCE_MS = 300; // silence after speech = end of utterance (the "endpointing"
// value): after this much silence, treat the caller as done and send the text immediately.
// 300ms balances snappy replies against not clipping a natural mid-phrase pause ("chips and
// [pause] salad"); below ~240 split those into two turns. 0 is impossible — it would fire
// mid-sentence and talk over the caller. The cache + partial probe carry the real speed; this
// knob is only tens of ms. (STT here is ElevenLabs Scribe + our own VAD, not Deepgram.)
const BARGE_SPEECH_MS = 120; // sustained speech during playback = barge-in
const MIN_UTTERANCE_MS = 200; // ignore blips shorter than this
// Short, plain filler spoken ONLY when a turn actually needs the LLM (a
// customisation / ambiguous request, ~1.2s think) — never on the instant
// fast-path turns — so the AI's thinking time isn't dead air. Cached for
// instant playback (see the boot warm list).
const AI_FILLER = "One sec.";

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
  private scribe: ScribeStream | null = null;
  private abort: AbortController | null = null;
  private speaking: SallyStream | null = null;
  private warmTts: SallyStream | null = null; // pre-opened at end-of-speech
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private consecutiveMisses = 0;

  // VAD state
  private speechMs = 0; // accumulated speech in the current utterance
  private silenceMs = 0; // trailing silence after speech
  private inUtterance = false;
  private awaitingReply = false; // a turn is being processed
  private bargeMs = 0; // sustained speech while we're speaking
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private commitAt = 0; // when we asked Scribe to finalise (for STT-RTT timing)
  private segmentHandled = false; // this utterance was answered off its partial (skip committed)

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
    const [settings, hours, menuCatalog] = await Promise.all([
      getSettings(db, restaurant.id),
      getHours(db, restaurant.id),
      buildMenuCatalog(db, restaurant.id),
    ]);
    const call = await startCall(db, {
      restaurantId: restaurant.id,
      twilioCallSid: callSid || `media-${this.streamSid}`,
      callerNumber: from && !from.startsWith("client:") ? from : "",
    });
    this.callId = call.id;

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
      callerNumber: from && !from.startsWith("client:") ? from : undefined,
      now: this.deps.now ?? (() => new Date()),
      menuCatalog,
    });
    void this.agent.prewarm();

    // Our own STT for the whole call.
    this.scribe = new ScribeStream({
      onCommitted: (text) => this.onCallerUtterance(text),
      onError: (m) => this.deps.log("scribe error", { m }),
    });

    // Speak the greeting ourselves (no platform welcome message here).
    await appendTranscript(db, call.id, {
      role: "assistant",
      text: settings.aiGreeting,
      at: new Date().toISOString(),
    });
    await this.speak(settings.aiGreeting);
  }

  /** Every 20ms Twilio frame: feed STT + run VAD (endpoint + barge-in). */
  private handleMedia(payloadB64: string): void {
    const mu = Buffer.from(payloadB64, "base64");
    this.scribe?.pushMuLaw(mu);
    const rms = muLawFrameRms(mu);
    const voice = rms > SPEECH_RMS;

    // Barge-in: caller talks while we're speaking -> stop instantly.
    if (this.speaking) {
      this.bargeMs = voice ? this.bargeMs + FRAME_MS : 0;
      if (this.bargeMs >= BARGE_SPEECH_MS) {
        this.deps.log("barge-in");
        this.stopSpeaking();
        this.sendClear();
        this.abort?.abort();
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
        if (!this.warmTts) this.warmTts = openSallyStream(env.ELEVENLABS_VOICE_ID);
      }
    } else if (this.inUtterance) {
      this.silenceMs += FRAME_MS;
      if (this.silenceMs >= ENDPOINT_SILENCE_MS && !this.awaitingReply) {
        this.inUtterance = false;
        this.speechMs = 0;
        this.silenceMs = 0;
        this.awaitingReply = true;
        this.segmentHandled = false;
        this.commitAt = Date.now();
        // Probe the live partial against the fast path RIGHT NOW (no round-trip).
        // A clean match answers instantly; a miss does nothing and the accurate
        // committed transcript (below) drives the turn ~400ms later.
        const partial = this.scribe?.peekPartial() ?? "";
        this.scribe?.commit(); // -> committed_transcript -> onCommitted -> onCallerUtterance
        if (partial) this.enqueueTurn(partial, 0, "probe");
      }
    }
  }

  private onCallerUtterance(text: string): void {
    // The committed (accurate) transcript arrived. If we already answered this
    // utterance off its partial (probe), ignore it — don't answer twice.
    if (this.segmentHandled) {
      this.segmentHandled = false;
      return;
    }
    this.awaitingReply = false;
    if (!text.trim() || this.closed) return;
    // STT round-trip: caller's silence -> our commit -> Scribe's final text.
    const sttMs = this.commitAt ? Date.now() - this.commitAt : 0;
    this.enqueueTurn(text.trim(), sttMs, "full");
  }

  private enqueueTurn(text: string, sttMs: number, mode: "probe" | "full"): void {
    this.turnQueue = this.turnQueue.then(() => this.runTurn(text, sttMs, mode)).catch(() => undefined);
  }

  private async runTurn(text: string, sttMs: number, mode: "probe" | "full"): Promise<void> {
    if (!this.agent || this.closed) return;
    const db = getDb();
    this.abort = new AbortController();
    const turnStarted = Date.now();

    let result: Awaited<ReturnType<OrderAgent["handleTurn"]>> | null;
    let fillerFired = false;
    if (mode === "probe") {
      // Fast path only, off the live partial. A miss means "not a clean
      // deterministic turn" — do nothing and let the committed transcript
      // drive a full turn (leave awaitingReply set so no new endpoint fires).
      result = await this.agent.tryFastPathOnly(text, {}, { probe: true });
      if (!result) return;
      this.segmentHandled = true; // committed transcript for this segment will be ignored
    } else {
      // Committed transcript. Probe the fast path first (no LLM). If it handles
      // the turn, reply instantly from cache — no filler. If not, this is a
      // genuine AI turn: fire a short plain filler ("One sec.") WHILE Claude
      // thinks, so the ~1.2s isn't dead air, then speak the real reply.
      const fast = await this.agent.tryFastPathOnly(text);
      if (fast) {
        result = fast;
      } else {
        fillerFired = true;
        const fillerPlaying = this.speak(AI_FILLER); // concurrent — covers the think
        let reply = "";
        result = await this.agent.handleTurn(
          text,
          { onText: (tok) => (reply += tok) },
          this.abort.signal,
        );
        if (!result.text && reply.trim()) result = { ...result, text: reply.trim() };
        await fillerPlaying; // ensure the filler finished before the real reply
      }
    }
    const speakText = (result.text || "").trim();
    const turnMs = Date.now() - turnStarted;

    if (this.callId) {
      await appendTranscript(db, this.callId, { role: "caller", text, at: new Date().toISOString() });
      if (fillerFired) {
        await appendTranscript(db, this.callId, {
          role: "assistant",
          text: AI_FILLER,
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

    if (result.endCall || this.consecutiveMisses >= 3) {
      const forceReview = this.consecutiveMisses >= 3;
      const delay = this.deps.endDelayMs ?? 800; // goodbye already finished playing
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

    // Reply delivered — allow the next utterance to endpoint. (A probe that
    // DIDN'T handle returned early above without reaching here, keeping
    // awaitingReply set so the committed transcript drives the turn instead.)
    this.awaitingReply = false;
  }

  /**
   * Speak text in Sally's voice; resolves when playback audio is fully sent.
   * Returns time-to-first-audio-chunk in ms (null if no audio was produced).
   */
  private async speak(text: string): Promise<number | null> {
    this.stopSpeaking();
    this.bargeMs = 0;

    // Cache hit: an invariant fast-path phrase already synthesised in Sally's
    // voice -> replay instantly, no ElevenLabs round-trip (0ms to first audio).
    const cached = getCachedUlaw(env.ELEVENLABS_VOICE_ID, text);
    if (cached && cached.length > 0) {
      this.speaking = CACHED_PLAYBACK; // so barge-in can interrupt the playout
      for (let i = 0; i < cached.length; i += 1600) this.sendMedia(cached.subarray(i, i + 1600));
      // mu-law 8kHz = 8000 bytes/sec; hold "speaking" for the playout so a
      // barge-in during it is caught (and flushed via sendClear).
      const playoutMs = Math.ceil(cached.length / 8);
      await new Promise((r) => setTimeout(r, playoutMs));
      if (this.speaking === CACHED_PLAYBACK) this.speaking = null;
      return 0;
    }

    // Live synthesis. Use the socket pre-opened when the caller started
    // speaking (its handshake already overlapped their speech); else open
    // fresh (greeting, or if the pre-opened one died before we used it).
    if (this.warmTts?.isDead()) this.warmTts = null;
    const stream = this.warmTts ?? openSallyStream(env.ELEVENLABS_VOICE_ID);
    this.warmTts = null;
    this.speaking = stream;
    const start = Date.now();
    let ttfb: number | null = null;
    const chunks: Buffer[] = [];
    await stream.speak(text, (chunk) => {
      if (ttfb === null) ttfb = Date.now() - start;
      chunks.push(chunk);
      this.sendMedia(chunk);
    });
    if (this.speaking === stream) this.speaking = null;
    // Cache invariant phrases so the next identical one is instant.
    if (chunks.length > 0) maybeCacheSpoken(env.ELEVENLABS_VOICE_ID, text, Buffer.concat(chunks));
    return ttfb;
  }

  private stopSpeaking(): void {
    if (this.speaking) {
      this.speaking.abort();
      this.speaking = null;
    }
  }

  private async finalise(forceOutcome?: CallOutcome): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const db = getDb();
    if (!this.callId) return;
    const state = this.agent?.state;
    let outcome: CallOutcome = forceOutcome ?? state?.outcome ?? "NO_ORDER";
    if (state?.draftOrderId && !state.reviewLinkSent) {
      const order = await getOrder(db, state.draftOrderId);
      if (order && order.status === "draft" && (order.subtotalCents > 0 || order.customerName)) {
        await markNeedsReview(db, order.id, "Call ended before the order was confirmed.");
        if (outcome === "NO_ORDER") outcome = "CALL_DROPPED";
      }
    }
    await endCall(db, this.callId, { status: "completed", outcome });
  }

  private async onClose(): Promise<void> {
    this.abort?.abort();
    this.stopSpeaking();
    this.warmTts?.abort();
    this.warmTts = null;
    this.scribe?.close();
    if (this.endTimer) clearTimeout(this.endTimer);
    await this.finalise();
  }
}
