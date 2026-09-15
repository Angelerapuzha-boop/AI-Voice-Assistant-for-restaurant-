import WebSocket from "ws";
import { env } from "@meatbox/core";
import { muLawToPcm16, upsample8to16, pcm16ToBytes } from "./audio";

/**
 * Streaming ElevenLabs clients for the custom media pipeline.
 *
 * ScribeStream  — realtime speech-to-text. We push 8kHz mu-law frames
 *   (from Twilio); it upsamples to 16kHz PCM, feeds Scribe v2 Realtime,
 *   and surfaces partial + committed transcripts. Our own VAD decides
 *   when to commit (end-of-speech), so endpointing is tunable here.
 *
 * speakWithSally — one-shot streaming TTS for a reply: opens a
 *   stream-input socket for the Sally voice, streams the text, and emits
 *   mu-law 8kHz audio chunks straight back to Twilio. Abortable for
 *   barge-in.
 */

const XI_KEY = () => env.ELEVENLABS_API_KEY;

export interface ScribeHandlers {
  onPartial?: (text: string) => void;
  onCommitted: (text: string) => void;
  onError?: (msg: string) => void;
}

export class ScribeStream {
  private ws: WebSocket | null = null;
  private ready = false;
  private queue: string[] = []; // base64 PCM16 frames buffered pre-open
  private closed = false;
  private lastPartial = ""; // most recent live partial for the current segment

  constructor(private readonly handlers: ScribeHandlers) {
    this.connect();
  }

  /** The latest live partial transcript (no round-trip). "" if none yet. */
  peekPartial(): string {
    return this.lastPartial.trim();
  }

  private connect(): void {
    // Force English: on a degraded/accented line Scribe's auto language
    // detection was mis-hearing English as Arabic/Portuguese and returning
    // garbage (Kevin's India->AU call, 2026-09-15), which missed the fast path
    // and stalled on the LLM. This restaurant is English-only.
    const url =
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=en";
    const ws = new WebSocket(url, { headers: { "xi-api-key": XI_KEY() } });
    this.ws = ws;
    ws.on("open", () => {
      this.ready = true;
      for (const b64 of this.queue.splice(0)) this.sendChunk(b64);
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: { message_type?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.message_type === "partial_transcript" && typeof msg.text === "string") {
        this.lastPartial = msg.text;
        this.handlers.onPartial?.(msg.text);
      } else if (
        (msg.message_type === "committed_transcript" ||
          msg.message_type === "committed_transcript_with_timestamps") &&
        typeof msg.text === "string"
      ) {
        this.lastPartial = "";
        if (msg.text.trim()) this.handlers.onCommitted(msg.text.trim());
      } else if (msg.message_type === "input_error") {
        this.handlers.onError?.(JSON.stringify(msg));
      }
    });
    ws.on("error", (err: Error) => this.handlers.onError?.(err.message));
    ws.on("close", () => {
      this.ready = false;
      // Auto-reconnect for the life of the call (a committed segment can
      // drop the socket; the next utterance needs a live one).
      if (!this.closed) setTimeout(() => this.connect(), 150);
    });
  }

  /** Feed one Twilio mu-law frame (8kHz). Upsampled to 16kHz PCM for Scribe. */
  pushMuLaw(mu: Buffer): void {
    const pcm16k = upsample8to16(muLawToPcm16(mu));
    const b64 = pcm16ToBytes(pcm16k).toString("base64");
    if (this.ready) this.sendChunk(b64);
    else if (this.queue.length < 400) this.queue.push(b64);
  }

  private sendChunk(audioBase64: string): void {
    this.ws?.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audioBase64,
        commit: false,
        sample_rate: 16000,
      }),
    );
  }

  /** End-of-speech: finalise the current segment -> committed_transcript. */
  commit(): void {
    if (this.ready) {
      this.ws?.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: 16000,
        }),
      );
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * A pre-connected Sally TTS stream. Open it the instant the caller stops
 * speaking (so the WebSocket handshake overlaps the brain's thinking
 * time, not the caller's wait); then call speak() once the reply text is
 * ready. One socket per utterance (EOS closes it). Abortable for barge-in.
 */
export interface SallyStream {
  speak: (text: string, onAudio: (muLawChunk: Buffer) => void) => Promise<void>;
  abort: () => void;
  /** True if the socket died (error/close) before it was used — caller should open a fresh one. */
  isDead: () => boolean;
}

export function openSallyStream(voiceId: string): SallyStream {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
    `?model_id=eleven_flash_v2&output_format=ulaw_8000&optimize_streaming_latency=4` +
    `&inactivity_timeout=180`; // opened at caller-speech-start; must survive a long utterance
  const ws = new WebSocket(url, { headers: { "xi-api-key": XI_KEY() } });
  let aborted = false;
  let opened = false;
  let used = false; // speak() has been called
  let dead = false; // socket died before use
  let pendingText: string | null = null;
  let audioCb: ((c: Buffer) => void) | null = null;
  let resolveDone: (() => void) | null = null;

  const sendBos = () => {
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.9, speed: 1.0, use_speaker_boost: true },
        generation_config: { chunk_length_schedule: [90, 130, 180, 250] },
      }),
    );
  };
  const flush = (text: string) => {
    ws.send(JSON.stringify({ text: `${text} `, flush: true }));
    ws.send(JSON.stringify({ text: "" })); // EOS -> isFinal
  };

  ws.on("open", () => {
    opened = true;
    sendBos();
    if (pendingText !== null) flush(pendingText);
  });
  ws.on("message", (raw: WebSocket.RawData) => {
    if (aborted) return;
    let msg: { audio?: string; isFinal?: boolean };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.audio && audioCb) audioCb(Buffer.from(msg.audio, "base64"));
    if (msg.isFinal) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolveDone?.();
    }
  });
  ws.on("error", () => {
    if (!used) dead = true;
    resolveDone?.();
  });
  ws.on("close", () => {
    if (!used) dead = true;
    resolveDone?.();
  });

  return {
    speak: (text, onAudio) =>
      new Promise<void>((resolve) => {
        used = true;
        audioCb = onAudio;
        resolveDone = resolve;
        if (opened) flush(text);
        else pendingText = text;
      }),
    abort: () => {
      aborted = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolveDone?.();
    },
    isDead: () => dead,
  };
}
