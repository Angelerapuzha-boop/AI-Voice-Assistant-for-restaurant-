import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { ReservationMachine, type ReservationContext } from "../src/agent/reservation-machine";
import { getReservationSettings, findReservations } from "../src/domain/reservations";
import type { ReservationSettings, RestaurantHoursRow } from "../src/types";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

/**
 * Regression for the Cekura-surfaced bug (2026-10-01): a correction to an
 * ALREADY-captured slot (party/date/time), said during a LATER step or after the
 * booking is confirmed, must be honoured — the machine previously only
 * re-interpreted the current slot, so "actually make it six" (at the name step)
 * and "no sorry, make it Thursday" (at the time step) were dropped. Includes
 * guards that a bare restatement without a correction cue does NOT silently move
 * a slot.
 */

let ctx: TestContext;
let db: pg.Pool;
let settings: ReservationSettings;
const TZ = "Australia/Perth";
const NOW = new Date("2026-10-01T02:00:00Z"); // Perth 10:00 — deterministic

const OPEN_24_7: RestaurantHoursRow[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d, isClosed: false, opensAt: "00:00", closesAt: "23:59",
})) as unknown as RestaurantHoursRow[];

function isoDate(offsetDays: number): string {
  const d = new Date(NOW.getTime() + offsetDays * 86_400_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function mk(): ReservationMachine {
  const rc: ReservationContext = {
    db, restaurantId: ctx.restaurant.id, restaurantName: "Meat Box", hours: OPEN_24_7,
    settings, timezone: TZ, now: () => NOW, callerPhone: undefined,
  };
  return new ReservationMachine(rc);
}

async function play(m: ReservationMachine, utterances: string[]): Promise<void> {
  for (const u of utterances) await m.next(u);
}
async function booking(phone: string) {
  return (await findReservations(db, ctx.restaurant.id, phone))[0];
}
function dow(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
  settings = await getReservationSettings(db, ctx.restaurant.id);
});
beforeEach(async () => { await resetTransactionalData(db); });

describe("late corrections to already-captured slots (Cekura regression)", () => {
  it("party correction at the NAME step wins (E1: 'actually make it six')", async () => {
    const phone = "+61411222801";
    await play(mk(), ["I'd like to book a table", "tomorrow", "seven", "four", "actually make it six", "Tara", "0411 222 801"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.partySize).toBe(6);
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("party correction stated with 'not' at the name step (E1b: 'six people not four')", async () => {
    const phone = "+61411222802";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "sorry, six people not four", "Nina", "0411 222 802"]);
    expect((await booking(phone))!.partySize).toBe(6);
  });

  it("date correction at the TIME step wins (E2: 'no sorry, make it Thursday')", async () => {
    const phone = "+61411222803";
    await play(mk(), ["book a table", "Wednesday", "no sorry, make it Thursday", "seven", "two", "Umar", "0411 222 803"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(dow(b!.reservationDate)).toBe(4); // Thursday
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("post-confirm party change is applied ('the party is for six, not four')", async () => {
    const phone = "+61411222804";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Tara", "0411 222 804"]);
    expect((await booking(phone))!.partySize).toBe(4);
    await m.next("actually the party is for six, not four");
    expect((await booking(phone))!.partySize).toBe(6);
  });

  it("post-confirm time change is applied ('can we do 8pm instead')", async () => {
    const phone = "+61411222805";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Willa", "0411 222 805"]);
    expect((await booking(phone))!.reservationTime.slice(0, 5)).toBe("19:00");
    await m.next("actually, can we do 8 pm instead");
    expect((await booking(phone))!.reservationTime.slice(0, 5)).toBe("20:00");
  });

  it("GUARD: a plain name is not misread as a date change", async () => {
    const phone = "+61411222806";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "June", "0411 222 806"]);
    const b = await booking(phone);
    expect(b!.customerName.toLowerCase()).toContain("june");
    expect(b!.reservationDate).toBe(isoDate(1)); // still tomorrow, not moved
  });

  it("GUARD: 'no, that's all thanks' at post-confirm does NOT modify the booking", async () => {
    const phone = "+61411222807";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Pat", "0411 222 807"]);
    const before = await booking(phone);
    const turn = await m.next("no, that's all thanks");
    const after = await booking(phone);
    expect(after!.partySize).toBe(before!.partySize);
    expect(after!.reservationTime).toBe(before!.reservationTime);
    expect(turn.endCall).toBe(true);
  });

  it("party AND name in ONE breath at the name step both land (E1 compound)", async () => {
    const phone = "+61411222811";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "actually make it six, the name's Tara", "0411 222 811"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.partySize).toBe(6);
    expect(b!.customerName.toLowerCase()).toContain("tara");
  });

  it("GUARD: name capture escalates after repeated misses — never an infinite loop", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four"]); // now at the name step
    await m.next("um"); // parseName rejects filler (spec)
    await m.next("um");
    const t3 = await m.next("um");
    expect(m.debug().state).toBe("ESCALATION");
    expect(t3.kind).toBe("escalate_name");
    expect(t3.say.toLowerCase()).not.toContain("let's try again");
  });

  it("GUARD: post-confirm 'make it 8pm instead' changes time only, not the date (P1)", async () => {
    const phone = "+61411222812";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Willa", "0411 222 812"]);
    const before = await booking(phone);
    await m.next("actually, can we make it 8 pm instead of 7");
    const after = await booking(phone);
    expect(after!.reservationTime.slice(0, 5)).toBe("20:00");
    expect(after!.reservationDate).toBe(before!.reservationDate); // date unchanged
  });
});

describe("accent sweep regressions (2026-10-02 Indian/British/American)", () => {
  it("K1: 'no, that's all for today' at post-confirm ENDS the call and does NOT move the booking to today", async () => {
    const phone = "+61411222851";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Priya", "0411 222 851"]);
    const before = await booking(phone);
    expect(before!.reservationDate).toBe(isoDate(1)); // tomorrow
    const turn = await m.next("No, that's all for today. Thank you. Goodbye!");
    const after = await booking(phone);
    expect(after!.reservationDate).toBe(isoDate(1)); // STILL tomorrow — a sign-off is not a date edit
    expect(after!.reservationTime).toBe(before!.reservationTime);
    expect(turn.endCall).toBe(true);
  });

  it("K1b: a GENUINE post-confirm date change WITH a change cue still applies", async () => {
    const phone = "+61411222852";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dev", "0411 222 852"]);
    const before = await booking(phone);
    await m.next("actually, can we move it to Saturday");
    const after = await booking(phone);
    expect(dow(after!.reservationDate)).toBe(6); // Saturday
    expect(after!.reservationDate).not.toBe(before!.reservationDate);
  });

  it("L1: a date word ('tomorrow') is never stored as the customer name", async () => {
    const phone = "+61411222853";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two"]); // now at the name step
    await m.next("tomorrow"); // must be rejected as a name, not stored
    await play(m, ["Yusuf", "0411 222 853"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.customerName.toLowerCase()).toContain("yusuf");
    expect(b!.customerName.toLowerCase()).not.toContain("tomorrow");
  });

  it("D3: a stray/duplicated time ('seven pm') at the party step is NOT booked as a party of 7", async () => {
    const phone = "+61411222861";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven pm"]); // time captured; now at the party step
    const t = await m.next("seven pm"); // a duplicated time — must NOT become party 7
    expect(t.say.toLowerCase()).toMatch(/how many|joining you|number|keypad/);
    await play(m, ["five", "Nadia", "0411 222 861"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.partySize).toBe(5); // five, never seven
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("B1: post-confirm 'actually, it's for half past seven' is a TIME correction, not a party of 7", async () => {
    const phone = "+61411222862";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "half past seven", "five", "Delia", "0411 222 862"]);
    const before = await booking(phone);
    expect(before!.partySize).toBe(5);
    expect(before!.reservationTime.slice(0, 5)).toBe("19:30");
    await m.next("actually, it's for half past seven");
    const after = await booking(phone);
    expect(after!.partySize).toBe(5); // NOT bumped to 7 by the "seven" in the time
    expect(after!.reservationTime.slice(0, 5)).toBe("19:30");
  });
});

describe("call-quality fixes from listening to recordings (Kevin's 6 items)", () => {
  it("#1 repeat request after confirmation reads the booking back and stays on the line", async () => {
    const phone = "+61411222821";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Marco", "0411 222 821"]);
    const t = await m.next("sorry, can you say that again?");
    expect(t.kind).toBe("repeat");
    expect(t.say).toMatch(/\bfor 4\b|\bfour\b/);
    expect(t.say).toMatch(/7\s?pm/i);
    expect(t.endCall).toBeFalsy();
    expect(m.debug().state).toBe("POST_CONFIRM"); // did not hang up
  });

  it("#1 repeat mid-booking summarises what's captured and re-asks", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven"]); // at the party step
    const t = await m.next("what did I say so far?");
    expect(t.kind).toBe("repeat");
    expect(t.say).toMatch(/7\s?pm/i);
  });

  it("#2/#6 does NOT hang up on a vague reply — gives the caller their last word", async () => {
    const phone = "+61411222822";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Pat", "0411 222 822"]);
    const vague = await m.next("um");
    expect(vague.endCall).toBeFalsy();
    expect(vague.kind).toBe("anything_else");
    const done = await m.next("no that's all thanks");
    expect(done.endCall).toBe(true);
    // booking still intact
    expect((await booking(phone))!.partySize).toBe(4);
  });

  it("#4 distracted caller is held once, then offered a call-back", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven"]); // at the party step
    const b1 = await m.next("hang on");
    expect(b1.kind).toBe("busy_hold");
    expect(b1.endCall).toBeFalsy();
    const b2 = await m.next("one sec");
    expect(b2.kind).toBe("busy_callback");
    expect(b2.endCall).toBe(true);
  });

  it("#5 conflicting dates are clarified, not guessed ('Monday' then 'Friday')", async () => {
    const phone = "+61411222825";
    const m = mk();
    await m.next("book a table");
    await m.next("next Monday");
    const t = await m.next("Friday at 7"); // different day, no correction cue → clarify
    expect(t.kind).toBe("confirm_date");
    expect(t.say.toLowerCase()).toContain("monday");
    expect(t.say.toLowerCase()).toContain("friday");
    const t2 = await m.next("Friday please");
    expect(t2.kind).toBe("ask_time"); // resumes collection
    await play(m, ["7 pm", "two", "Gina", "0411 222 825"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(dow(b!.reservationDate)).toBe(5); // Friday
  });
});
