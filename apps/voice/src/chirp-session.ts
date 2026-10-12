import type { WebSocket } from "ws";
import {
  buildKeyterms,
  ConversationalReservationBrain,
  createAnthropicLlm,
  endCall,
  getDb,
  getDefaultRestaurant,
  getHours,
  getReservationSettings,
  getSettings,
  startCall,
  type ReservationBrain,
} from "@meatbox/core";
import { muLawFrameRms, muLawToPcm16, pcm16ToBytes, pcm16ToMuLaw, upsample8to16 } from "./audio";
import { openStt, openTts, type SttStream } from "./voice-providers";
import { type SallyStream } from "./elevenlabs-stream";

/**
 * CHIRP session — Cekura external voice-testing transport for the reservation
 * assistant. Cekura connects to us as a WebSocket CLIENT and streams the
 * simulated caller's audio as raw pcm_s16le 16 kHz mono binary frames, marking
 * utterance boundaries with JSON control events ({type:"speech.started"} /
 * {type:"speech.completed"}). We run that audio through the SAME Scribe STT and
 * the SAME reservation brain, and reply with the SAME Sally TTS — only the
 * audio framing differs from the Twilio path. Caller audio is down-converted to
 * 8 kHz mu-law before STT (and Sally's 8 kHz mu-law up-converted back to 16 kHz
 * PCM) so the STT/TTS see exactly the degraded-8 kHz audio production uses.
 *
 * This is additive test-only tooling: the production Twilio Media Streams
 * pipeline (media-stream-session.ts) is untouched. Bookings are tagged
 * source="cekura_test" for isolation/auto-cleanup.
 */

// A short, reservation-flavoured keyterm set to bias Scribe (names + the words a
// caller actually says when booking). Scribe caps at 50 terms / 20 chars each.
const RESERVATION_KEYTERMS = [
  "booking", "table", "reservation", "tonight", "tomorrow", "today",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "window", "booth", "outside", "outdoor", "allergy", "gluten", "vegan",
  "vegetarian", "birthday", "anniversary", "high chair", "wheelchair",
  "Kevin", "Dave", "Sarah", "Priya", "John", "Raju", "Emma", "Liam", "Olivia",
  "Noah", "Aisha", "Mohammed", "Chen", "Sophie", "Jack",
];

// Endpointing/barge-in tuning — same scale as production (mu-law 8 kHz frames).
// Cekura streams continuous audio with NO speech.started/completed events, so
// the adapter owns VAD exactly like the Twilio media-stream path does.
const SPEECH_RMS = 550; // above this = voice present
const BARGE_RMS = 1600; // caller clearly talking over the agent -> interrupt
// CHIRP-only endpoint override (CHIRP_ENDPOINT_SILENCE_MS) so the test rig's
// endpoint can be swept independently of the live Twilio/media-stream path (which
// keeps its own hand-tuned ENDPOINT_SILENCE_MS=900). Falls back to the shared var,
// then 900. Clamped to a sane range.
const ENDPOINT_SILENCE_MS = (() => {
  const v = Number(process.env.CHIRP_ENDPOINT_SILENCE_MS) || Number(process.env.ENDPOINT_SILENCE_MS) || 900;
  return Math.min(3000, Math.max(200, v));
})();
const MIN_SPEECH_MS = 200; // ignore a lone noisy frame

/** Little-endian PCM16 bytes -> Int16Array. */
function bytesToPcm16(buf: Buffer): Int16Array {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** 16 kHz PCM16 -> 8 kHz PCM16 (decimate by 2 — matches the 8 kHz line). */
function downsample16to8(pcm: Int16Array): Int16Array {
  const n = pcm.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm[i * 2]!;
  return out;
}

interface ChirpDeps {
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export class ChirpSession {
  private stt: SttStream | null = null;
  private machine: ReservationBrain | null = null;
  private currentTts: SallyStream | null = null;
  private committedBuffer = "";
  private finalResolver: ((t: string) => void) | null = null;
  private busy = false;
  private ended = false;
  private callId: string | undefined;
  private turns = 0;
  private audioFrames = 0;
  private audioBytes = 0;
  // VAD state (adapter-owned endpointing). Cekura streams audio only WHILE the
  // caller speaks and goes quiet (no frames) during silence, so endpointing is
  // wall-clock based (time since last speech), not frame-counted silence.
  private inUtterance = false;
  private speechMs = 0;
  private lastSpeechAt = 0;
  private greetingSent = false;
  private endpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: ChirpDeps,
  ) {
    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.onAudio(data);
      else this.onControl(data.toString());
    });
    this.socket.on("close", () => this.cleanup());
    this.socket.on("error", (err: Error) => {
      this.deps.log("chirp socket error", { err: err.message });
      this.cleanup();
    });
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const db = getDb();
      const restaurant = await getDefaultRestaurant(db);
      const [settings, hours, reservationSettings] = await Promise.all([
        getSettings(db, restaurant.id),
        getHours(db, restaurant.id),
        getReservationSettings(db, restaurant.id),
      ]);
      const call = await startCall(db, {
        restaurantId: restaurant.id,
        twilioCallSid: `cekura-chirp-${Date.now()}`,
        callerNumber: "cekura_test",
      });
      this.callId = call.id;

      this.stt = openStt(
        {
          onCommitted: (text) => this.onCommitted(text),
          onError: (msg) => this.deps.log("chirp stt error", { msg }),
        },
        buildKeyterms(RESERVATION_KEYTERMS),
      );

      const resCtx = {
        db,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        hours,
        settings: reservationSettings,
        timezone: restaurant.timezone,
        now: () => new Date(),
        callId: call.id,
        customerSmsEnabled: false, // never text the synthetic test caller
        address: restaurant.address,
        phoneDisplay: restaurant.phoneDisplay,
        source: "cekura_test",
      };
      // Cekura's test transport exists to VALIDATE the new conversational brain,
      // so it always runs the LLM brain — independent of the phone line's
      // BOOKING_BRAIN default, which keeps real callers on the proven brain.
      this.machine = ConversationalReservationBrain.fromLlm(
        resCtx,
        createAnthropicLlm("claude-haiku-4-5"),
        (m, meta) => this.deps.log(m, meta ?? {}),
      );

      this.deps.log("chirp connected", { callId: this.callId });
      // Wall-clock endpointer: fire a turn once the caller has been silent for
      // ENDPOINT_SILENCE_MS, whether that silence is quiet frames or no frames.
      this.endpointTimer = setInterval(() => this.checkEndpoint(), 120);
      // agent_speaks_first: open with the greeting (no recording notice — this
      // is a test transport, not a recorded phone line).
      await this.speak(this.machine.opening({ recordingNotice: false }));
      this.greetingSent = true;
      this.deps.log("chirp greeting sent", {});
    } catch (err) {
      this.deps.log("chirp init failed", { err: (err as Error).message });
      this.closeSoon();
    }
  }

  /** Caller audio frame (pcm_s16le 16 kHz) -> 8 kHz mu-law -> Scribe. */
  private onAudio(buf: Buffer): void {
    this.audioFrames += 1;
    this.audioBytes += buf.length;
    if (!this.stt || this.ended) return;
    const mu = pcm16ToMuLaw(downsample16to8(bytesToPcm16(buf)));
    const frameMs = mu.length / 8; // mu-law 8 kHz: 8 samples(bytes)/ms
    const rms = muLawFrameRms(mu);
    this.stt.pushMuLaw(mu);

    if (rms >= SPEECH_RMS) {
      // Caller is talking. If the agent is mid-REPLY (not the greeting), this is
      // a barge-in — stop the reply. The greeting is allowed to finish.
      if (this.greetingSent && this.currentTts && rms >= BARGE_RMS) {
        this.currentTts.abort();
        this.currentTts = null;
      }
      this.inUtterance = true;
      this.speechMs += frameMs;
      this.lastSpeechAt = Date.now();
    }

    if (this.audioFrames === 1 || this.audioFrames % 150 === 0) {
      this.deps.log("chirp audio", { frames: this.audioFrames, bytes: this.audioBytes, rms });
    }
  }

  /** Wall-clock endpoint check (runs on a timer): the caller has stopped. */
  private checkEndpoint(): void {
    if (!this.inUtterance || this.busy || this.ended || !this.greetingSent) return;
    if (Date.now() - this.lastSpeechAt < ENDPOINT_SILENCE_MS) return;
    const hadSpeech = this.speechMs >= MIN_SPEECH_MS;
    this.inUtterance = false;
    this.speechMs = 0;
    if (hadSpeech) void this.endOfCallerTurn();
  }

  private onControl(raw: string): void {
    this.deps.log("chirp control", { raw: raw.slice(0, 200) });
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "speech.started") {
      // Caller started talking — barge in: stop our current reply.
      if (this.currentTts) {
        this.currentTts.abort();
        this.currentTts = null;
      }
    } else if (msg.type === "speech.completed") {
      void this.endOfCallerTurn();
    }
  }

  private onCommitted(text: string): void {
    this.deps.log("chirp stt committed", { text: text.slice(0, 160) });
    this.committedBuffer = this.committedBuffer ? `${this.committedBuffer} ${text}` : text;
    if (this.finalResolver) {
      const resolve = this.finalResolver;
      this.finalResolver = null;
      const t = this.committedBuffer.trim();
      this.committedBuffer = "";
      resolve(t);
    }
  }

  /** Cekura's VAD declared end-of-speech: finalise STT and run one brain turn. */
  private async endOfCallerTurn(): Promise<void> {
    if (!this.stt || !this.machine || this.busy || this.ended) return;
    this.busy = true;
    try {
      this.stt.commit();
      const text = await this.waitForFinal(1800);
      this.deps.log("chirp end-of-turn", { text: text.slice(0, 160), empty: !text });
      if (!text) return;
      this.turns += 1;
      const turn = await this.machine.next(text);
      this.deps.log("chirp turn", {
        n: this.turns,
        heard: text.slice(0, 120),
        say: turn.say.slice(0, 120),
        state: this.machine.debug().state,
        endCall: turn.endCall,
      });
      await this.speak(turn.say);
      if (turn.endCall) this.closeSoon();
    } catch (err) {
      this.deps.log("chirp turn failed", { err: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  /** Resolve with the committed transcript for this utterance (buffer now, the
   * next commit after our commit(), or the live partial on timeout). */
  private waitForFinal(ms: number): Promise<string> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (t: string) => {
        if (done) return;
        done = true;
        this.finalResolver = null;
        resolve(t);
      };
      this.finalResolver = (t) => finish(t);
      setTimeout(() => {
        const t = (this.committedBuffer || this.stt?.peekPartial() || "").trim();
        this.committedBuffer = "";
        finish(t);
      }, ms);
    });
  }

  /** Synthesise one reply with Sally and stream it to Cekura as 16 kHz PCM. */
  private async speak(text: string): Promise<void> {
    if (!text || this.ended) return;
    let tts = openTts();
    if (tts.isDead()) tts = openTts();
    this.currentTts = tts;
    await tts.speak(text, (muLawChunk) => {
      if (this.ended || this.currentTts !== tts) return;
      // Sally emits 8 kHz mu-law; CHIRP wants 16 kHz PCM16 binary frames.
      const pcm16k = pcm16ToBytes(upsample8to16(muLawToPcm16(muLawChunk)));
      try {
        this.socket.send(pcm16k, { binary: true });
      } catch {
        /* socket gone */
      }
    });
    if (this.currentTts === tts) this.currentTts = null;
  }

  private closeSoon(): void {
    // Allow the last audio frames to flush before closing.
    setTimeout(() => {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }, 500);
  }

  private cleanup(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.endpointTimer) {
      clearInterval(this.endpointTimer);
      this.endpointTimer = null;
    }
    try {
      this.currentTts?.abort();
    } catch {
      /* noop */
    }
    try {
      this.stt?.close();
    } catch {
      /* noop */
    }
    if (this.callId) {
      const outcome = this.machine?.reservation ? "ORDER_COMPLETED" : "NO_ORDER";
      endCall(getDb(), this.callId, { status: "completed", outcome }).catch(() => {
        /* best effort */
      });
    }
  }
}
