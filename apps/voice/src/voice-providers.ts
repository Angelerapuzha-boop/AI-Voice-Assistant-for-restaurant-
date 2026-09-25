import { env } from "@meatbox/core";
import { ScribeStream, openSallyStream, type SallyStream, type ScribeHandlers } from "./elevenlabs-stream";
import { openPollyStream } from "./polly-tts";
import { TranscribeStream } from "./transcribe-stt";

/**
 * Speech-provider selection for the custom media stack. Default = ElevenLabs
 * (Sally + Scribe, US). Setting TTS_PROVIDER=polly / STT_PROVIDER=transcribe
 * swaps in the all-Australian stack (Amazon Polly "Olivia" + Amazon Transcribe,
 * Sydney) with no other code change — both providers implement the exact same
 * interfaces the session already drives.
 */

/** The subset of ScribeStream the session uses — either STT provider fits it. */
export interface SttStream {
  peekPartial(): string;
  pushMuLaw(mu: Buffer): void;
  commit(): void;
  close(): void;
}

export function openStt(handlers: ScribeHandlers, keyterms: string[] = []): SttStream {
  // keyterms bias Scribe toward the menu vocabulary; Amazon Transcribe has its
  // own vocabulary mechanism, so it ignores this list for now.
  return env.STT_PROVIDER === "transcribe"
    ? new TranscribeStream(handlers)
    : new ScribeStream(handlers, keyterms);
}

/** Open a TTS stream for one reply. ElevenLabs pre-opens a socket (voiceId
 * needed); Polly has no socket so the arg is ignored. */
export function openTts(): SallyStream {
  return env.TTS_PROVIDER === "polly" ? openPollyStream() : openSallyStream(env.ELEVENLABS_VOICE_ID);
}

/** Whether the active TTS keeps a pre-openable socket worth warming at
 * speech-start. Polly is stateless (a fresh synth per reply), so warming is a
 * no-op there and the session should skip it. */
export function ttsSupportsWarmup(): boolean {
  return env.TTS_PROVIDER !== "polly";
}

/** The id of the CURRENTLY ACTIVE voice — used to key the audio cache so a
 * Polly-generated phrase is never replayed in Sally's voice (or vice-versa)
 * when the provider is switched. */
export function activeVoiceId(): string {
  return env.TTS_PROVIDER === "polly" ? `polly:${env.POLLY_VOICE_ID}` : env.ELEVENLABS_VOICE_ID;
}
