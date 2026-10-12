import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ConversationalReservationBrain } from "../src/agent/reservation-brain";
import type { ReservationContext } from "../src/agent/reservation-machine";
import { createAnthropicLlm } from "../src/agent/llm";
import { getReservationSettings } from "../src/domain/reservations";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * LIVE end-to-end: the WHOLE conversational brain (real Haiku 4.5 interpreter +
 * state manager + real DB engine + planner) driven through full conversations.
 * Gated behind RUN_LIVE=1 so it never runs in normal CI (it calls the real API
 * and costs money). Run it with:
 *   RUN_LIVE=1 pnpm --filter @meatbox/core exec vitest run test/reservation-brain-live.spec.ts
 * It prints the dialogue, per-turn latency, and which turns were instant
 * (deterministic fast-path) vs LLM — the honest latency profile of the delivered
 * brain — and asserts the forbidden outcomes never happen.
 */

const LIVE = process.env.RUN_LIVE === "1";
let tctx: TestContext;
let db: pg.Pool;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-05T02:00:00Z");

beforeAll(async () => { if (LIVE) { tctx = await setupTestDb(); db = tctx.db; } });
afterAll(async () => { if (LIVE && db) await db.end(); });
beforeEach(async () => { if (LIVE) await resetTransactionalData(db); });

async function runConversation(title: string, phone: string, turns: string[]): Promise<ConversationalReservationBrain> {
  const fastFlags: boolean[] = [];
  const rc: ReservationContext = {
    db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
    settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ, now: () => NOW,
    callerPhone: phone, address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
  };
  const brain = ConversationalReservationBrain.fromLlm(
    rc, createAnthropicLlm("claude-haiku-4-5"),
    (m, meta) => { if (m === "brain-turn") fastFlags.push(Boolean((meta as { fast?: boolean }).fast)); },
  );
  console.log(`\n\n=== ${title} ===`);
  console.log(`AI : ${brain.opening()}`);
  const times: number[] = [];
  for (const u of turns) {
    const started = Date.now();
    const r = await brain.next(u);
    const ms = Date.now() - started;
    times.push(ms);
    const tag = fastFlags[fastFlags.length - 1] ? "fast" : "LLM ";
    console.log(`👤 : ${u}`);
    console.log(`AI : [${tag} ${String(ms).padStart(4)}ms] ${r.say}`);
  }
  const llmTurns = fastFlags.filter(Boolean).length;
  const llmTimes = times.filter((_, i) => !fastFlags[i]).sort((a, b) => a - b);
  console.log(`--- ${turns.length} turns: ${turns.length - llmTurns} LLM, ${llmTurns} fast | LLM median ${llmTimes.length ? llmTimes[Math.floor(llmTimes.length / 2)] : 0}ms ---`);
  return brain;
}

describe.skipIf(!LIVE)("LIVE conversational brain — real Haiku interpreter, end to end", () => {
  it("scenario 1: a straightforward booking", async () => {
    const m = await runConversation("Straightforward booking", "+61400999001", [
      "Hi, I'd like to book a table",
      "this Saturday",
      "half past seven",
      "four of us",
      "the name's Kevin",
      "yes that's perfect",
      "no that's everything, thanks",
    ]);
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.partySize).toBe(4);
  });

  it("scenario 2: the 'very bad' call — a date change mid-flow must win", async () => {
    const m = await runConversation("Date change mid-flow (recreation)", "+61400999002", [
      "I'd like to book a table",
      "the twelfth of October",
      "around seven",
      "two people",
      "Wait, can you change the date? Make it the fourteenth of November instead",
      "It's Joseph",
      "yes that's right",
    ]);
    expect(m.reservation?.reservationDate).toBe("2026-11-14");
    expect(m.reservation?.customerName?.toLowerCase()).toContain("joseph");
  });

  it("scenario 3: out of order, a question mid-flow, and a correction", async () => {
    const m = await runConversation("Out of order + question + correction", "+61400999003", [
      "table for six this Friday",
      "do you have parking nearby?",
      "half seven",
      "actually make it eight people",
      "under the name Priya",
      "yep lock it in",
      "no thanks, bye",
    ]);
    expect(m.reservation?.status).toBe("CONFIRMED");
    expect(m.reservation?.partySize).toBe(8);
  });
});
