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
const ENDPOINT_SILENCE_MS = 350; // silence after speech = end of utterance (spec #9)
const BARGE_SPEECH_MS = 120; // sustained speech during playback = barge-in
const MIN_UTTERANCE_MS = 200; // ignore blips shorter than this

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
      if (this.speechMs >= MIN_UTTERANCE_MS) this.inUtterance = true;
    } else if (this.inUtterance) {
      this.silenceMs += FRAME_MS;
      if (this.silenceMs >= ENDPOINT_SILENCE_MS && !this.awaitingReply) {
        this.inUtterance = false;
        this.speechMs = 0;
        this.silenceMs = 0;
        this.awaitingReply = true;
        // Pre-open Sally's socket NOW so the handshake overlaps the brain's
        // thinking, not the caller's wait.
        this.warmTts = openSallyStream(env.ELEVENLABS_VOICE_ID);
        this.scribe?.commit(); // -> onCommitted -> onCallerUtterance
      }
    }
  }

  private onCallerUtterance(text: string): void {
    this.awaitingReply = false;
    if (!text.trim() || this.closed) return;
    this.enqueueTurn(text.trim());
  }

  private enqueueTurn(text: string): void {
    this.turnQueue = this.turnQueue.then(() => this.runTurn(text)).catch(() => undefined);
  }

  private async runTurn(text: string): Promise<void> {
    if (!this.agent || this.closed) return;
    const db = getDb();
    if (this.callId) {
      await appendTranscript(db, this.callId, { role: "caller", text, at: new Date().toISOString() });
    }
    this.abort = new AbortController();
    const turnStarted = Date.now();

    // Collect the whole reply, then speak it (fast-path returns instantly;
    // the LLM path streams — we buffer to one Sally utterance for clean audio).
    let reply = "";
    const result = await this.agent.handleTurn(
      text,
      { onText: (tok) => (reply += tok) },
      this.abort.signal,
    );
    const speakText = (result.text || reply).trim();
    const turnMs = Date.now() - turnStarted;

    if (this.callId) {
      await recordCallEvent(db, this.callId, turnMs > 8000 ? "slow_turn" : "turn_metrics", {
        turnMs,
        toolCalls: result.toolCalls.length,
        interrupted: result.interrupted,
        fastPath: result.fastPath ?? null,
        assistantWords: speakText ? speakText.split(/\s+/).length : 0,
      });
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

    if (!result.interrupted && speakText) await this.speak(speakText);

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
  }

  /** Speak text in Sally's voice; resolves when playback audio is fully sent. */
  private async speak(text: string): Promise<void> {
    this.stopSpeaking();
    this.bargeMs = 0;
    // Use the socket pre-opened at end-of-speech if we have one (its
    // handshake already overlapped the brain); else open fresh (greeting).
    const stream = this.warmTts ?? openSallyStream(env.ELEVENLABS_VOICE_ID);
    this.warmTts = null;
    this.speaking = stream;
    await stream.speak(text, (chunk) => this.sendMedia(chunk));
    if (this.speaking === stream) this.speaking = null;
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
