import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openTts } from "./voice-providers";

/**
 * Sally audio cache for the DETERMINISTIC fast-path phrases.
 *
 * The fast-path replies are the same words every call ("Anything else?",
 * "chips and salad, or rice and salad?", "What name shall I put it under?",
 * the greeting). Re-synthesising them through ElevenLabs on every turn costs
 * ~300-900ms of the caller's felt gap. We synthesise each once, cache the
 * mu-law bytes (memory + disk), and replay them INSTANTLY — no round-trip.
 *
 * Only invariant phrases are cached (see isCacheablePhrase): lines that carry
 * an order's total, name or ETA are never cached (they vary per call).
 */

const CACHE_DIR = fileURLToPath(new URL("../../../.tts-cache/", import.meta.url));
const mem = new Map<string, Buffer>();

function keyFor(voiceId: string, text: string): string {
  return createHash("sha1").update(`${voiceId}|${text}`).digest("hex");
}

function diskPath(key: string): string {
  return `${CACHE_DIR}${key}.ulaw`;
}

/** Cached mu-law audio for this exact phrase, or null. Memory first, then disk. */
export function getCachedUlaw(voiceId: string, text: string): Buffer | null {
  const key = keyFor(voiceId, text);
  const hit = mem.get(key);
  if (hit) return hit;
  try {
    const buf = fs.readFileSync(diskPath(key));
    if (buf.length > 0) {
      mem.set(key, buf);
      return buf;
    }
  } catch {
    /* not on disk */
  }
  return null;
}

function putCachedUlaw(voiceId: string, text: string, buf: Buffer): void {
  if (buf.length === 0) return;
  const key = keyFor(voiceId, text);
  mem.set(key, buf);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(diskPath(key), buf);
  } catch {
    /* memory cache still serves this process */
  }
}

/**
 * Invariant reply? Cache only phrases with no order-specific content — no
 * digits (rules out totals/ETAs) and short. Names never appear in the
 * fast-path's fixed questions, so the digit test is a safe proxy.
 */
export function isCacheablePhrase(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 80 && !/\d/.test(t);
}

/** One-shot synthesis of a phrase to mu-law 8k bytes (collects the stream), via
 * whichever TTS provider is active (Sally or Olivia). The voiceId is only the
 * cache key; the provider is chosen by env. */
export async function synthesizeUlaw(_voiceId: string, text: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = openTts();
  await stream.speak(text, (c) => chunks.push(c));
  return Buffer.concat(chunks);
}

/** Synthesise + cache a phrase if not already cached. */
export async function cachePhrase(voiceId: string, text: string): Promise<void> {
  if (!isCacheablePhrase(text)) return;
  if (getCachedUlaw(voiceId, text)) return;
  const buf = await synthesizeUlaw(voiceId, text);
  putCachedUlaw(voiceId, text, buf);
}

/** Store audio produced by a live turn so the next identical phrase is instant. */
export function maybeCacheSpoken(voiceId: string, text: string, buf: Buffer): void {
  if (isCacheablePhrase(text) && buf.length > 0 && !getCachedUlaw(voiceId, text)) {
    putCachedUlaw(voiceId, text, buf);
  }
}

/**
 * Cache a KNOWN-FIXED phrase even if it's long (bypasses the isCacheablePhrase
 * length/digit guard). ONLY for lines that are invariant by construction — the
 * greeting and the set closing lines — never for anything that carries a caller's
 * name, number, total or date. The greeting is ~130 chars, so without this it was
 * re-synthesised through ElevenLabs on EVERY call (the start-of-call lag Kevin
 * reported 2026-10-07). Force-caching it makes the first audio instant thereafter. */
export function forceCacheSpoken(voiceId: string, text: string, buf: Buffer): void {
  if (text.trim().length > 0 && buf.length > 0 && !getCachedUlaw(voiceId, text)) {
    putCachedUlaw(voiceId, text, buf);
  }
}

/** Synthesise + cache a fixed phrase regardless of length (see forceCacheSpoken). */
export async function cacheFixedPhrase(voiceId: string, text: string): Promise<void> {
  if (!text.trim() || getCachedUlaw(voiceId, text)) return;
  const buf = await synthesizeUlaw(voiceId, text);
  forceCacheSpoken(voiceId, text, buf);
}

/** Pre-generate KNOWN-FIXED long phrases (greeting / closes) so they're instant on
 * the very first call. Like warmPhrases but bypasses the length/digit guard — pass
 * ONLY invariant lines. Safe to call repeatedly; cached phrases are skipped. */
export async function warmFixed(
  voiceId: string,
  phrases: string[],
  log?: (msg: string) => void,
): Promise<void> {
  const todo = [...new Set(phrases)].filter((p) => p.trim().length > 0 && !getCachedUlaw(voiceId, p));
  if (todo.length === 0) return;
  log?.(`tts-cache: warming ${todo.length} fixed phrase(s)`);
  const CONCURRENCY = 3;
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (i < todo.length) {
      const text = todo[i++]!;
      try {
        await cacheFixedPhrase(voiceId, text);
      } catch (err) {
        log?.(`tts-cache: fixed warm failed for "${text}": ${(err as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  log?.("tts-cache: fixed warm complete");
}

/**
 * Pre-generate the fixed phrases (limited concurrency) so they are instant on
 * the very first call. Safe to call repeatedly — cached phrases are skipped,
 * failures are swallowed (lazy caching will retry on first use).
 */
export async function warmPhrases(
  voiceId: string,
  phrases: string[],
  log?: (msg: string) => void,
): Promise<void> {
  const todo = [...new Set(phrases)].filter((p) => isCacheablePhrase(p) && !getCachedUlaw(voiceId, p));
  if (todo.length === 0) return;
  log?.(`tts-cache: warming ${todo.length} phrase(s)`);
  const CONCURRENCY = 3;
  let i = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (i < todo.length) {
      const text = todo[i++]!;
      try {
        await cachePhrase(voiceId, text);
      } catch (err) {
        log?.(`tts-cache: warm failed for "${text}": ${(err as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  log?.("tts-cache: warm complete");
}
