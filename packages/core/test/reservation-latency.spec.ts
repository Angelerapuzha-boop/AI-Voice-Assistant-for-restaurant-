import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext } from "../src/agent/reservation-machine";
import { getReservationSettings } from "../src/domain/reservations";
import { interpretPartySize } from "../src/agent/reservation-parse";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * Brain-latency measurement (spec §30). The reservation brain runs NO LLM — a
 * turn is regex parsing plus at most one Postgres availability query (or a
 * create transaction). This measures that deterministic cost so we can prove it
 * stays low, and guards against a regression that sneaks an LLM / slow path in.
 *
 * NB this is the BRAIN component only. The caller-felt gap on a real call is
 * STT + brain + TTS-first-audio, recorded per-turn as turn_metrics on the box.
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z");
const OPEN: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function isoDate(off: number): string {
  const d = new Date(NOW.getTime() + off * 86_400_000);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const q = Object.fromEntries(p.formatToParts(d).map((x) => [x.type, x.value]));
  return `${q.year}-${q.month}-${q.day}`;
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
function mk(phone: string): ReservationMachine {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN,
    settings, timezone: TZ, now: () => NOW, callerPhone: phone,
  };
  return new ReservationMachine(rc);
}

beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

describe("reservation brain latency (spec §30)", () => {
  it("pure number parsing is sub-millisecond", () => {
    const times: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const t = process.hrtime.bigint();
      interpretPartySize("about four", { expectingParty: true });
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`[parse] P50=${pct(times, 50).toFixed(4)}ms P99=${pct(times, 99).toFixed(4)}ms`);
    expect(pct(times, 99)).toBeLessThan(1);
  });

  it("a full booking's per-turn brain time stays low (incl. DB availability + create)", async () => {
    await db.query(`UPDATE reservation_settings SET max_covers_per_slot = 500`);
    settings = await getReservationSettings(db, ctx.restaurant.id);
    const perTurn: number[] = [];
    const N = 120;
    for (let i = 0; i < N; i++) {
      const phone = `+61490${String(500000 + i).slice(-6)}`;
      const m = mk(phone);
      const utterances = ["book a table", isoDate(3 + (i % 100)), "seven", "four", "Kevin"];
      for (const u of utterances) {
        const t = process.hrtime.bigint();
        await m.next(u);
        perTurn.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    perTurn.sort((a, b) => a - b);
    const p50 = pct(perTurn, 50), p90 = pct(perTurn, 90), p95 = pct(perTurn, 95), p99 = pct(perTurn, 99);
    // eslint-disable-next-line no-console
    console.log(`[brain per-turn, n=${perTurn.length}] P50=${p50.toFixed(2)}ms P90=${p90.toFixed(2)}ms P95=${p95.toFixed(2)}ms P99=${p99.toFixed(2)}ms max=${perTurn[perTurn.length - 1]!.toFixed(2)}ms`);
    // Generous CI bound — the brain must never approach an LLM-turn cost.
    expect(p95).toBeLessThan(150);
  });
});
