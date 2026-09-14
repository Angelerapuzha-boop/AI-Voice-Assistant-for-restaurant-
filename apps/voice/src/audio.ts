/**
 * Telephony audio helpers for the custom media-stream pipeline.
 * Twilio Media Streams carry 8kHz mono G.711 mu-law. ElevenLabs Scribe
 * wants linear PCM16; ElevenLabs TTS can return mu-law 8kHz directly.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** One G.711 mu-law byte -> one signed 16-bit PCM sample. */
export function muLawDecodeSample(mu: number): number {
  mu = ~mu & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/** One signed 16-bit PCM sample -> one G.711 mu-law byte. */
export function muLawEncodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Buffer of mu-law bytes -> Int16Array of PCM samples (same 8kHz rate). */
export function muLawToPcm16(mu: Buffer): Int16Array {
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) out[i] = muLawDecodeSample(mu[i]!);
  return out;
}

/** PCM16 samples -> mu-law byte Buffer (same rate). */
export function pcm16ToMuLaw(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncodeSample(pcm[i]!);
  return out;
}

/** Linear 2x upsample 8kHz -> 16kHz PCM16 (interpolated). */
export function upsample8to16(pcm: Int16Array): Int16Array {
  const out = new Int16Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const cur = pcm[i]!;
    const next = i + 1 < pcm.length ? pcm[i + 1]! : cur;
    out[i * 2] = cur;
    out[i * 2 + 1] = (cur + next) >> 1;
  }
  return out;
}

/** Int16Array -> little-endian byte Buffer (for base64 to Scribe). */
export function pcm16ToBytes(pcm: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf;
}

/**
 * RMS energy (0..~32768) of a mu-law frame — cheap voice-activity signal.
 * Silence on a telephony line sits near a low floor; speech spikes well
 * above it. Used for end-of-speech detection and barge-in.
 */
export function muLawFrameRms(mu: Buffer): number {
  if (mu.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < mu.length; i++) {
    const s = muLawDecodeSample(mu[i]!);
    sum += s * s;
  }
  return Math.sqrt(sum / mu.length);
}
