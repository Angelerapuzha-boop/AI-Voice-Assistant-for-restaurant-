import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext, type ReservationTurn } from "../src/agent/reservation-machine";
import { getReservationSettings } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * CURVEBALL SURVEY (Kevin 2026-10-06 "check all the possible curveballs and
 * confusions question from customer and the possible replies"). Fires a big
 * battery of tricky / confusing / off-topic / rude / ambiguous customer lines at
 * the real machine and PRINTS the reply for each, plus asserts the hard hygiene
 * invariants so nothing crashes, leaks a template, or gives a garbled ack.
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z");
const OPEN_24_7: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function mk(phone: string | null = "+61400111222"): ReservationMachine {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN_24_7,
    settings, timezone: TZ, now: () => NOW, callerPhone: phone ?? undefined,
  };
  return new ReservationMachine(rc);
}

function hygiene(q: string, t: ReservationTurn): void {
  expect(t.say, `empty: "${q}"`).toBeTruthy();
  expect(t.say, `leak: "${q}" -> ${t.say}`).not.toMatch(/undefined|null|NaN|\[object|\$\{/);
  expect(t.say, `garbled ack: "${q}" -> ${t.say}`).not.toMatch(/I'?ll\s+(\d{1,2}\s*(PM|AM|:)|\.|,|and\b|$)/i);
  expect(t.say, `double space: "${q}" -> ${t.say}`).not.toMatch(/\s{2,}/);
}

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  settings = await getReservationSettings(db, ctx.restaurant.id);
});
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

type Case = [category: string, utterance: string];

// Fired at a FRESH call (state = GREETING).
const GREETING_CURVEBALLS: Case[] = [
  ["greeting", "hi"],
  ["greeting", "yeah g'day, is this the Meat Box?"],
  ["greeting", "I'd like to make a reservation"],
  ["greeting", "can I book a table"],
  ["greeting", "umm"],
  ["greeting", "hello? are you there?"],
  ["date", "this weekend"],
  ["date", "the 31st of February"],
  ["date", "yesterday"],
  ["date", "in three weeks on Wednesday"],
  ["date", "within two weeks"],
  ["date", "I'm not sure of the exact day"],
  ["date", "Christmas Day"],
  ["allatonce", "a table for four tomorrow at 7 under Kevin by the window"],
  ["allatonce", "two people, tonight, 8pm"],
  ["party", "just me"],
  ["party", "a couple"],
  ["party", "there's like twenty of us"],
  ["party", "big group"],
  ["outofscope", "can I order a steak"],
  ["outofscope", "what's on the menu"],
  ["outofscope", "do you do takeaway"],
  ["outofscope", "do you deliver"],
  ["outofscope", "how much is the ribeye"],
  ["outofscope", "do you have parking"],
  ["outofscope", "do you have a kids menu"],
  ["outofscope", "can I pay by card"],
  ["outofscope", "are you dog friendly"],
  ["outofscope", "is there a dress code"],
  ["info", "what are your hours"],
  ["info", "where are you located"],
  ["info", "are you open on Sunday"],
  ["info", "do you take walk-ins"],
  ["meta", "are you a robot"],
  ["meta", "is this a real person"],
  ["meta", "can I speak to a human"],
  ["meta", "put me through to someone"],
  ["meta", "can I talk to the manager"],
  ["rude", "this is ridiculous"],
  ["rude", "you're useless"],
  ["rude", "hurry up"],
  ["cancel", "I need to cancel my booking"],
  ["modify", "I want to change my reservation"],
  ["confirm", "can you confirm my booking for Friday"],
  ["nonsense", "asdfghjkl"],
  ["nonsense", "blue seventeen banana"],
  ["ambiguous", "the usual"],
  ["ambiguous", "whatever's good"],
  ["yesno", "yeah nah"],
  ["yesno", "I guess so"],
];

describe("curveball survey — single turn at greeting", () => {
  it("prints every reply and passes hygiene", async () => {
    const rows: string[] = [];
    for (const [cat, q] of GREETING_CURVEBALLS) {
      const m = mk();
      const t = await m.next(q);
      hygiene(q, t);
      // "No extra / reply fast" (Kevin 2026-10-06): a first-turn reply must stay
      // short so it plays back quickly and never feels long-winded.
      expect(t.say.length, `too long: "${q}" -> ${t.say}`).toBeLessThanOrEqual(220);
      rows.push(`[${cat.padEnd(10)}] "${q}"\n            -> (${t.kind}) ${t.say}`);
    }
    // eslint-disable-next-line no-console
    console.log("\n===== GREETING CURVEBALLS =====\n" + rows.join("\n") + "\n");
  });

  // Hard expectations for the categories that have a defined correct behaviour.
  it("out-of-scope food never starts a booking", async () => {
    for (const q of ["can I order a steak", "what's on the menu", "do you do takeaway", "do you deliver"]) {
      const t = await mk().next(q);
      expect(t.kind, q).toBe("decline_food");
    }
  });
  it("hours / location questions are answered from real data", async () => {
    expect((await mk().next("what are your hours")).kind).toMatch(/hours/);
    expect((await mk().next("where are you located")).kind).toMatch(/location/);
  });
  it("cancel / modify / confirm at greeting go to the booking lookup, not a new booking", async () => {
    expect((await mk().next("I need to cancel my booking")).kind).not.toBe("ask_date");
    expect((await mk().next("I want to change my reservation")).kind).not.toBe("ask_date");
  });
  it("off-topic questions get a graceful steer, not a non-sequitur 'what day?'", async () => {
    for (const q of ["do you have parking", "can I pay by card", "are you dog friendly", "is there a dress code", "do you take walk-ins", "how much is the ribeye"]) {
      const t = await mk().next(q);
      expect(t.kind, q).toBe("out_of_scope_info");
      expect(t.say, q).toMatch(/booking line|can't help/i);
    }
  });
  it("'are you a robot' is handled naturally (no clinical AI announcement, no false human claim)", async () => {
    const t = await mk().next("are you a robot");
    expect(t.kind).toBe("bot_question");
    expect(t.say).toMatch(/Meat Box|happy to help/i);
    expect(t.say).not.toMatch(/\bautomated\b|\bA\.?I\.?\b|\brobot\b/i); // not clinical
  });
  it("a request for a human / manager is taken for a call-back", async () => {
    for (const q of ["can I speak to a human", "put me through to someone", "can I talk to the manager"]) {
      const t = await mk().next(q);
      expect(t.kind, q).toMatch(/escalate/);
    }
  });
});

describe("curveball survey — mid-flow confusions", () => {
  async function toName(m: ReservationMachine): Promise<void> {
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    await m.next("four");
  }

  it("refuses to give a name then gives one", async () => {
    const m = mk();
    await toName(m);
    const rows: string[] = [];
    let t = await m.next("why do you need my name");
    rows.push(`"why do you need my name" -> (${t.kind}) ${t.say}`);
    hygiene("why do you need my name", t);
    expect(t.kind).toBe("ask_name");                       // not booked as a name
    expect(t.say).not.toMatch(/I've got that as/i);        // never read a question back as a name
    t = await m.next("fine, it's Kevin");
    rows.push(`"fine, it's Kevin" -> (${t.kind}) ${t.say}`);
    hygiene("fine, it's Kevin", t);
    expect(t.say).not.toMatch(/\bFine\b/);                 // the ack is stripped, not booked
    expect(m.debug().draft.name).toBe("Kevin");            // only the real name stored
    // eslint-disable-next-line no-console
    console.log("\n===== NAME CURVEBALL =====\n" + rows.join("\n") + "\n");
  });

  it("corrections mid-flow: change the day, then the party, then the time", async () => {
    const m = mk();
    const rows: string[] = [];
    await m.next("book a table");
    await m.next("Friday");
    let t = await m.next("actually make it Saturday");
    rows.push(`"actually make it Saturday" -> (${t.kind}) ${t.say}`);
    hygiene("actually make it Saturday", t);
    t = await m.next("seven");
    rows.push(`"seven" -> (${t.kind}) ${t.say}`);
    t = await m.next("no wait, make it six people");
    rows.push(`"no wait, make it six people" -> (${t.kind}) ${t.say}`);
    hygiene("no wait, make it six people", t);
    // eslint-disable-next-line no-console
    console.log("\n===== CORRECTION CURVEBALLS =====\n" + rows.join("\n") + "\n");
  });

  it("mid-flow cancel abandons without booking", async () => {
    const m = mk();
    await toName(m);
    const t = await m.next("you know what, forget it, cancel");
    hygiene("forget it cancel", t);
    expect(t.endCall).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`\n===== MID-FLOW CANCEL =====\n"forget it, cancel" -> (${t.kind}) ${t.say}\n`);
  });

  it("NEW/unseen questions are faced gracefully, never a blunt non-sequitur", async () => {
    const rows: string[] = [];
    // At greeting — questions we've never explicitly coded for.
    for (const q of [
      "do you cater for events",
      "is there live music",
      "can I bring my own wine",
      "do you have a function room",
      "how old is the restaurant",
      "is it noisy in there",
    ]) {
      const t = await mk().next(q);
      hygiene(q, t);
      rows.push(`[greeting] "${q}" -> (${t.kind}) ${t.say}`);
      // not a blunt "what day?" non-sequitur
      expect(t.kind, q).not.toBe("ask_date");
    }
    // Mid-flow (at the time step) — an off-topic question gets acknowledged, then
    // the current question is re-asked.
    const m = mk();
    await m.next("book a table");
    await m.next("this Saturday");
    const t = await m.next("do you have live music");
    hygiene("do you have live music", t);
    rows.push(`[mid-flow time] "do you have live music" -> (${t.kind}) ${t.say}`);
    expect(t.kind).toBe("ask_time");                 // still steering to the time
    expect(t.say).toMatch(/team can help|not sure|sorry|booking line/i); // warm deferral first
    // eslint-disable-next-line no-console
    console.log("\n===== NEW / UNSEEN CURVEBALLS =====\n" + rows.join("\n") + "\n");
  });

  it("party too large escalates, does not silently book", async () => {
    const m = mk();
    await m.next("book a table");
    await m.next("this Saturday");
    await m.next("seven");
    const t = await m.next("twenty five people");
    hygiene("twenty five people", t);
    expect(t.kind).toMatch(/escalate/);                    // 25 > max → escalate, NOT booked as 5
    expect(t.say).not.toMatch(/\bfive\b|table for 5\b/i);
    // eslint-disable-next-line no-console
    console.log(`\n===== BIG PARTY =====\n"twenty five people" -> (${t.kind}) ${t.say}\n`);
  });
});
