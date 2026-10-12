import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext } from "../src/agent/reservation-machine";
import { getReservationSettings } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * Prints the FULL customer-facing dialogue for a natural booking so the exact
 * wording/flow can be read and judged against the reference audio (Kevin
 * 2026-10-06). Not an assertion test — a readable transcript of what the caller
 * actually hears, end to end.
 */
let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Thu 10:00 Perth
const OPEN: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "17:00", closesAt: "01:00",
})) as unknown as RestaurantHoursRow[];

beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; settings = await getReservationSettings(db, ctx.restaurant.id); });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

function mk(): ReservationMachine {
  return new ReservationMachine({
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN,
    settings, timezone: TZ, now: () => NOW, callerPhone: "+61455500001",
  });
}

async function transcript(title: string, lines: string[]): Promise<void> {
  const m = mk();
  const out: string[] = [`\n================  ${title}  ================`, `  AI : ${m.opening()}`];
  for (const line of lines) {
    out.push(`  👤 : ${line}`);
    const t = await m.next(line);
    out.push(`  AI : ${t.say}`);
  }
  // eslint-disable-next-line no-console
  console.log(out.join("\n") + "\n");
}

describe("full customer-facing transcripts (read against the reference)", () => {
  it("a natural, warm booking end to end", async () => {
    await transcript("NATURAL BOOKING", [
      "hi there, I'd like to book a table please",
      "Saturday night",
      "around seven",
      "there'll be four of us",
      "it's under Dave",
      "yeah, that's the one",
      "actually it's my wife's birthday",
      "somewhere a bit quiet if you can",
      "no allergies thanks",
      "yeah, lock it in",
      "no that's all, cheers",
    ]);
  });

  it("a customer who changes their mind a couple of times", async () => {
    await transcript("CHANGES MID-FLOW", [
      "can I get a table for Friday",
      "actually make it Saturday",
      "7:30",
      "six people",
      "no wait, eight people",
      "the name's Priya",
      "P-R-I-Y-A",
      "yes that number's fine",
      "no occasion",
      "no thanks",
      "yep that's great",
      "all good, thanks",
    ]);
  });

  it("a customer who asks questions mid-booking", async () => {
    await transcript("QUESTIONS MID-BOOKING", [
      "are you open this Sunday",
      "ok, Sunday then",
      "do you have parking",
      "half past six",
      "two of us",
      "Sam",
      "yes",
      "no, nothing special",
      "lock it in please",
      "cheers, bye",
    ]);
  });
});
