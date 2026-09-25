import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";
import { env } from "@meatbox/core";
import { pcm16ToMuLaw } from "./audio";
import type { SallyStream } from "./elevenlabs-stream";

/**
 * Amazon Polly TTS ("Olivia", en-AU) as a drop-in for SallyStream — the
 * Australian voice for the all-AU stack. Polly returns 8kHz signed-16-bit PCM;
 * we mu-law encode it to Twilio's telephony format and emit it in frames as it
 * streams back.
 *
 * Unlike the ElevenLabs socket there is no persistent connection to pre-open
 * (one HTTPS synth per reply), so isDead() is always false and there is nothing
 * to warm. In-region (Polly co-located with the server) a short reply's first
 * audio is ~100-200ms; generative is the most natural engine, neural the
 * lowest-latency — switch via POLLY_ENGINE if a call ever feels slow.
 */

let client: PollyClient | null = null;
function pollyClient(): PollyClient {
  if (!client) {
    const creds =
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}; // on EC2 the SDK finds the attached instance role
    client = new PollyClient({ region: env.AWS_REGION, ...creds });
  }
  return client;
}

export function openPollyStream(): SallyStream {
  let aborted = false;
  return {
    isDead: () => false,
    abort: () => {
      aborted = true;
    },
    speak: async (text, onAudio) => {
      const say = text.trim();
      if (!say) return;
      const res = await pollyClient().send(
        new SynthesizeSpeechCommand({
          Text: say,
          VoiceId: env.POLLY_VOICE_ID as VoiceId,
          Engine: env.POLLY_ENGINE as Engine,
          LanguageCode: "en-AU",
          OutputFormat: "pcm", // signed 16-bit little-endian mono
          SampleRate: "8000", // telephony rate — no resample needed
        }),
      );
      const body = res.AudioStream as AsyncIterable<Uint8Array> | undefined;
      if (!body) return;
      // 2 bytes per PCM16 sample; an odd trailing byte carries to the next chunk.
      let leftover = Buffer.alloc(0);
      for await (const chunk of body) {
        if (aborted) return;
        const buf = Buffer.concat([leftover, Buffer.from(chunk)]);
        const usable = buf.length - (buf.length % 2);
        leftover = Buffer.from(buf.subarray(usable));
        if (usable === 0) continue;
        const pcm = new Int16Array(usable / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
        const mu = pcm16ToMuLaw(pcm);
        if (mu.length > 0) onAudio(mu);
      }
    },
  };
}
