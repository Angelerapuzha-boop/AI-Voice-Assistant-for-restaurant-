import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
} from "@aws-sdk/client-transcribe-streaming";
import { env } from "@meatbox/core";
import { muLawToPcm16, pcm16ToBytes } from "./audio";
import type { ScribeHandlers } from "./elevenlabs-stream";

/**
 * Amazon Transcribe (streaming, en-AU) as a drop-in for ScribeStream — the
 * Australian speech-to-text for the all-AU stack. We push 8kHz mu-law frames
 * (from Twilio); it decodes to 8kHz PCM16 and streams to Transcribe, surfacing
 * partial + final transcripts.
 *
 * Timing model matches the ElevenLabs pipeline: our own VAD (in the session)
 * decides end-of-speech and calls commit(), which finalises off the latest
 * stabilised partial immediately — so the reply isn't gated on Transcribe's own
 * endpointing lag — and the matching Transcribe final is then swallowed so the
 * utterance isn't processed twice.
 *
 * NB Phase 2: validate live on a real call (Transcribe may occasionally split a
 * long utterance into multiple finals; add debouncing here if so).
 */
export class TranscribeStream {
  private queue: Buffer[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private lastPartial = "";
  private swallowNextFinal = false;

  constructor(private readonly handlers: ScribeHandlers) {
    void this.run();
  }

  peekPartial(): string {
    return this.lastPartial.trim();
  }

  pushMuLaw(mu: Buffer): void {
    if (this.closed) return;
    this.queue.push(pcm16ToBytes(muLawToPcm16(mu))); // 8kHz mu-law -> 8kHz PCM16 LE
    this.wake?.();
    this.wake = null;
  }

  /** End-of-speech (our VAD): finalise off the current stabilised partial now,
   *  and swallow Transcribe's own final for this segment. */
  commit(): void {
    const p = this.lastPartial.trim();
    if (p) {
      this.lastPartial = "";
      this.swallowNextFinal = true;
      this.handlers.onCommitted(p);
    }
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  private async *audioEvents(): AsyncGenerator<AudioStream> {
    while (!this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        continue;
      }
      const chunk = this.queue.shift()!;
      yield { AudioEvent: { AudioChunk: new Uint8Array(chunk) } };
    }
  }

  private async run(): Promise<void> {
    const creds =
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {};
    const client = new TranscribeStreamingClient({ region: env.AWS_REGION, ...creds });
    try {
      const resp = await client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: env.TRANSCRIBE_LANGUAGE as never, // "en-AU"
          MediaSampleRateHertz: 8000,
          MediaEncoding: "pcm",
          AudioStream: this.audioEvents(),
          EnablePartialResultsStabilization: true,
          PartialResultsStability: "high",
        }),
      );
      for await (const event of resp.TranscriptResultStream ?? []) {
        if (this.closed) break;
        const results = event.TranscriptEvent?.Transcript?.Results ?? [];
        for (const r of results) {
          const text = r.Alternatives?.[0]?.Transcript ?? "";
          if (!text) continue;
          if (r.IsPartial) {
            this.lastPartial = text;
            this.handlers.onPartial?.(text);
          } else if (this.swallowNextFinal) {
            this.swallowNextFinal = false; // our VAD commit already delivered this segment
          } else {
            this.lastPartial = "";
            if (text.trim()) this.handlers.onCommitted(text.trim());
          }
        }
      }
    } catch (err) {
      if (!this.closed) this.handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
}
