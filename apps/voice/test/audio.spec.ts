import { describe, expect, it } from "vitest";
import {
  muLawDecodeSample,
  muLawEncodeSample,
  muLawToPcm16,
  pcm16ToMuLaw,
  upsample8to16,
  pcm16ToBytes,
  muLawFrameRms,
} from "../src/audio";

describe("mu-law codec", () => {
  it("round-trips PCM through mu-law within quantisation error", () => {
    for (const sample of [0, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000]) {
      const decoded = muLawDecodeSample(muLawEncodeSample(sample));
      // mu-law is lossy but monotonic; error grows with amplitude but stays
      // a small fraction of full scale.
      expect(Math.abs(decoded - sample)).toBeLessThan(Math.abs(sample) * 0.2 + 200);
    }
  });

  it("encodes silence and loud samples to the canonical mu-law bytes", () => {
    expect(muLawEncodeSample(0)).toBe(0xff); // digital silence
    // Encode/decode preserve sign
    expect(muLawDecodeSample(muLawEncodeSample(5000))).toBeGreaterThan(0);
    expect(muLawDecodeSample(muLawEncodeSample(-5000))).toBeLessThan(0);
  });

  it("buffer helpers preserve length", () => {
    const mu = Buffer.from([0xff, 0x7f, 0x00, 0x80, 0x33]);
    const pcm = muLawToPcm16(mu);
    expect(pcm.length).toBe(5);
    const back = pcm16ToMuLaw(pcm);
    expect(back.length).toBe(5);
  });

  it("upsamples 8k to 16k doubling the sample count", () => {
    const pcm = Int16Array.from([0, 1000, -1000, 500]);
    const up = upsample8to16(pcm);
    expect(up.length).toBe(8);
    expect(up[0]).toBe(0);
    expect(up[2]).toBe(1000);
    expect(up[1]).toBe(500); // interpolated midpoint of 0 and 1000
  });

  it("pcm16ToBytes writes little-endian 2 bytes per sample", () => {
    const bytes = pcm16ToBytes(Int16Array.from([1, -1]));
    expect(bytes.length).toBe(4);
    expect(bytes.readInt16LE(0)).toBe(1);
    expect(bytes.readInt16LE(2)).toBe(-1);
  });

  it("RMS is near zero for silence and high for a loud tone", () => {
    const silence = pcm16ToMuLaw(new Int16Array(160)); // zeros
    expect(muLawFrameRms(silence)).toBeLessThan(50);
    const loud = pcm16ToMuLaw(Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 12000 : -12000)));
    expect(muLawFrameRms(loud)).toBeGreaterThan(5000);
  });
});
