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
    await play(mk(), ["I'd like to book a table", "tomorrow", "seven", "four", "actually make it six", "Tara", "0411 222 801", "no thanks", "yes please"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.partySize).toBe(6);
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("party correction stated with 'not' at the name step (E1b: 'six people not four')", async () => {
    const phone = "+61411222802";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "sorry, six people not four", "Nina", "0411 222 802", "no thanks", "yes please"]);
    expect((await booking(phone))!.partySize).toBe(6);
  });

  it("date correction at the TIME step wins (E2: 'no sorry, make it Thursday')", async () => {
    const phone = "+61411222803";
    await play(mk(), ["book a table", "Wednesday", "no sorry, make it Thursday", "seven", "two", "Umar", "0411 222 803", "no thanks", "yes please"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(dow(b!.reservationDate)).toBe(4); // Thursday
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("post-confirm party change is applied ('the party is for six, not four')", async () => {
    const phone = "+61411222804";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Tara", "0411 222 804", "no thanks", "yes please"]);
    expect((await booking(phone))!.partySize).toBe(4);
    await m.next("actually the party is for six, not four");
    expect((await booking(phone))!.partySize).toBe(6);
  });

  it("post-confirm time change is applied ('can we do 8pm instead')", async () => {
    const phone = "+61411222805";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Willa", "0411 222 805", "no thanks", "yes please"]);
    expect((await booking(phone))!.reservationTime.slice(0, 5)).toBe("19:00");
    await m.next("actually, can we do 8 pm instead");
    expect((await booking(phone))!.reservationTime.slice(0, 5)).toBe("20:00");
  });

  it("GUARD: a plain name is not misread as a date change", async () => {
    const phone = "+61411222806";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "June", "0411 222 806", "no thanks", "yes please"]);
    const b = await booking(phone);
    expect(b!.customerName.toLowerCase()).toContain("june");
    expect(b!.reservationDate).toBe(isoDate(1)); // still tomorrow, not moved
  });

  it("GUARD: 'no, that's all thanks' at post-confirm does NOT modify the booking", async () => {
    const phone = "+61411222807";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Pat", "0411 222 807", "no thanks", "yes please"]);
    const before = await booking(phone);
    const turn = await m.next("no, that's all thanks");
    const after = await booking(phone);
    expect(after!.partySize).toBe(before!.partySize);
    expect(after!.reservationTime).toBe(before!.reservationTime);
    expect(turn.endCall).toBe(true);
  });

  it("party AND name in ONE breath at the name step both land (E1 compound)", async () => {
    const phone = "+61411222811";
    await play(mk(), ["book a table", "tomorrow", "seven", "four", "actually make it six, the name's Tara", "0411 222 811", "no thanks", "yes please"]);
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
    await play(m, ["book a table", "tomorrow", "seven", "two", "Willa", "0411 222 812", "no thanks", "yes please"]);
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
    await play(m, ["book a table", "tomorrow", "seven", "two", "Priya", "0411 222 851", "no thanks", "yes please"]);
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
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dev", "0411 222 852", "no thanks", "yes please"]);
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
    await play(m, ["Yusuf", "0411 222 853", "no thanks", "yes please"]);
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
    await play(m, ["five", "Nadia", "0411 222 861", "no thanks", "yes please"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(b!.partySize).toBe(5); // five, never seven
    expect(b!.reservationTime.slice(0, 5)).toBe("19:00");
  });

  it("B1: post-confirm 'actually, it's for half past seven' is a TIME correction, not a party of 7", async () => {
    const phone = "+61411222862";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "half past seven", "five", "Delia", "0411 222 862", "no thanks", "yes please"]);
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
    await play(m, ["book a table", "tomorrow", "seven", "four", "Marco", "0411 222 821", "no thanks", "yes please"]);
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
    await play(m, ["book a table", "tomorrow", "seven", "four", "Pat", "0411 222 822", "no thanks", "yes please"]);
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
    await play(m, ["7 pm", "two", "Gina", "0411 222 825", "no thanks", "yes please"]);
    const b = await booking(phone);
    expect(b).toBeTruthy();
    expect(dow(b!.reservationDate)).toBe(5); // Friday
  });
});

describe("confirm beat before booking (Kevin: a clear gap to say confirmed or cancel)", () => {
  it("reads the booking back and creates NOTHING until the caller confirms", async () => {
    const phone = "+61411222871";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar"]);
    const te = await m.next("0411 222 871");
    expect(te.kind).toBe("ask_extras"); // dedicated special-touches turn first
    const t = await m.next("no thanks");
    expect(t.kind).toBe("confirm_booking"); // reads it back, asks to lock in
    expect(t.say.toLowerCase()).toMatch(/lock that in/);
    expect(t.endCall).toBeFalsy();
    expect(await booking(phone)).toBeUndefined(); // NOT booked yet
    const t2 = await m.next("yes please");
    expect(t2.kind).toBe("confirmed");
    expect((await booking(phone))!.partySize).toBe(2);
  });

  it("cancelling at the confirm step books NOTHING and ends warmly", async () => {
    const phone = "+61411222872";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar", "0411 222 872"]);
    const t = await m.next("actually no, don't book it");
    expect(t.kind).toBe("booking_abandoned");
    expect(t.endCall).toBe(true);
    expect(await booking(phone)).toBeUndefined();
  });

  it("a plain 'no' opens a change, then re-confirms and books the change", async () => {
    const phone = "+61411222873";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar", "0411 222 873"]);
    await m.next("no thanks"); // the special-touches turn
    const t = await m.next("no");
    expect(t.kind).toBe("confirm_change");
    const t2 = await m.next("make it four");
    expect(t2.kind).toBe("confirm_booking"); // re-reads the updated booking
    expect(t2.say).toMatch(/four/i);
    await m.next("yes");
    expect((await booking(phone))!.partySize).toBe(4);
  });

  it("a direct change at the confirm step ('no, make it six') re-reads and books the change", async () => {
    const phone = "+61411222874";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "four", "Omar", "0411 222 874"]);
    await m.next("no thanks"); // the special-touches turn
    const t = await m.next("no, make it six");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).toMatch(/six/i);
    await m.next("yes");
    expect((await booking(phone))!.partySize).toBe(6);
  });

  // Kevin's live call: he said "Raju" but it was mis-heard and booked as "Got",
  // with no way to fix it. The confirm beat must let the caller correct the name.
  it("a NAME correction at the confirm step is applied ('no, the name's Raju')", async () => {
    const phone = "+61411222881";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Mark", "0411 222 881"]);
    await m.next("no thanks"); // the special-touches turn
    const t = await m.next("no, the name's Raju");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).toMatch(/raju/i);
    await m.next("yes");
    expect((await booking(phone))!.customerName.toLowerCase()).toContain("raju");
  });

  it("a NAME change via the 'what would you like to change' path is applied", async () => {
    const phone = "+61411222882";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Mark", "0411 222 882"]);
    await m.next("no thanks"); // the special-touches turn
    await m.next("no"); // -> what would you like to change
    const t = await m.next("the name is Raju");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say).toMatch(/raju/i);
    await m.next("yes");
    expect((await booking(phone))!.customerName.toLowerCase()).toContain("raju");
  });

  it("asks the special-touches question (occasion / seating / dietary) as its own turn", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar"]);
    const t = await m.next("0411 222 891");
    expect(t.kind).toBe("ask_extras");
    expect(t.say.toLowerCase()).toMatch(/special|seating|dietary|occasion/);
  });

  it("a special request given at the special-touches turn is noted and read back at confirm", async () => {
    const phone = "+61411222892";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar", "0411 222 892"]);
    const t = await m.next("actually, can we sit by the window?");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say.toLowerCase()).toContain("window");
    await m.next("yes");
    const b = await booking(phone);
    expect((b!.specialRequests || "").toLowerCase()).toContain("window");
  });

  it("captures a quiet table and pram space at the special-touches turn", async () => {
    const phone = "+61411222894";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar", "0411 222 894"]);
    const t = await m.next("somewhere quiet please, and we'll have a pram");
    expect(t.kind).toBe("confirm_booking");
    const say = t.say.toLowerCase();
    expect(say).toContain("quiet");
    expect(say).toContain("pram");
    await m.next("yes");
    const sr = ((await booking(phone))!.specialRequests || "").toLowerCase();
    expect(sr).toContain("quiet table");
    expect(sr).toContain("pram space");
  });

  it("an occasion mentioned at the special-touches turn is noted and read back", async () => {
    const phone = "+61411222893";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Omar", "0411 222 893"]);
    const t = await m.next("it's our anniversary");
    expect(t.kind).toBe("confirm_booking");
    expect(t.say.toLowerCase()).toContain("occasion"); // "I've noted special occasion"
    await m.next("yes");
    const b = await booking(phone);
    expect((b!.specialRequests || "").toLowerCase()).toContain("occasion");
  });

  it("GUARD: 'the time' at the change step is not stored as the name", async () => {
    const phone = "+61411222883";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dave", "0411 222 883"]);
    await m.next("no thanks"); // the special-touches turn
    await m.next("no"); // -> what would you like to change
    const t = await m.next("the time"); // wants to change time but hasn't named one yet
    expect(t.kind).toBe("confirm_change"); // re-ask, NOT booked, NOT name="time"
    await m.next("eight pm");
    await m.next("yes");
    const b = await booking(phone);
    expect(b!.customerName.toLowerCase()).toContain("dave"); // name unchanged
    expect(b!.reservationTime.slice(0, 5)).toBe("20:00");
  });
});

describe("end-of-call: confirm locks in, sudden cancel drops it (Kevin: feel human)", () => {
  it("a literal 'confirm' at the confirm beat locks the booking in", async () => {
    const phone = "+61411222901";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dave", "0411 222 901", "no thanks"]);
    const t = await m.next("confirm");
    expect(t.kind).toBe("confirmed");
    expect((await booking(phone))!.partySize).toBe(2);
  });

  it("a bare 'go ahead' at the confirm beat locks it in", async () => {
    const phone = "+61411222902";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dave", "0411 222 902", "no thanks"]);
    const t = await m.next("go ahead");
    expect(t.kind).toBe("confirmed");
  });

  it("a sudden 'cancel it' at the confirm beat books NOTHING", async () => {
    const phone = "+61411222903";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dave", "0411 222 903", "no thanks"]);
    const t = await m.next("actually, cancel it");
    expect(t.kind).toBe("booking_abandoned");
    expect(t.endCall).toBe(true);
    expect(await booking(phone)).toBeUndefined();
  });

  it("a sudden 'cancel' mid-booking ends the call with no booking", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow"]); // at the time step
    const t = await m.next("actually, cancel it");
    expect(t.kind).toBe("booking_abandoned");
    expect(t.endCall).toBe(true);
  });

  it("a sudden 'cancel' right after confirming cancels the booking", async () => {
    const phone = "+61411222905";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two", "Dave", "0411 222 905", "no thanks", "yes please"]);
    expect(await booking(phone)).toBeTruthy(); // booked
    const t = await m.next("oh wait, cancel that");
    expect(t.kind).toBe("cancelled_same_call");
    expect(t.endCall).toBe(true);
    expect(m.reservation).toBeNull();
  });
});

describe("doubtful-name confirmation + spelling (Kevin: confirm or spell a mis-heard name)", () => {
  it("a common name is trusted — no extra confirmation turn", async () => {
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two"]);
    const t = await m.next("Dave"); // common -> straight on, no confirm_name
    expect(t.kind).not.toBe("confirm_name");
  });

  it("a doubtful name is read back for confirmation and accepted on 'yes'", async () => {
    const phone = "+61411222897";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two"]);
    const t = await m.next("Zephyrine"); // uncommon -> confirm + offer to spell
    expect(t.kind).toBe("confirm_name");
    expect(t.say.toLowerCase()).toContain("zephyrine");
    expect(t.say.toLowerCase()).toMatch(/spell/);
    await play(m, ["yes that's right", "0411 222 897", "no thanks", "yes please"]);
    expect((await booking(phone))!.customerName.toLowerCase()).toContain("zephyrine");
  });

  it("a doubtful name can be spelled out when mis-heard", async () => {
    const phone = "+61411222898";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two"]);
    await m.next("Zephyrine"); // -> confirm_name
    const t = await m.next("no, let me spell it"); // -> spell_name
    expect(t.kind).toBe("spell_name");
    const t2 = await m.next("Z A P H I R"); // builds "Zaphir"
    expect(t2.kind).toBe("ask_phone"); // name accepted, moves on
    await play(m, ["0411 222 898", "no thanks", "yes please"]);
    expect((await booking(phone))!.customerName.toLowerCase()).toContain("zaphir");
  });

  it("a spelled name given directly at the confirmation is used", async () => {
    const phone = "+61411222899";
    const m = mk();
    await play(m, ["book a table", "tomorrow", "seven", "two"]);
    await m.next("Zephyrine"); // -> confirm_name
    const t = await m.next("it's R A J U"); // spelled right away
    expect(t.kind).toBe("ask_phone");
    await play(m, ["0411 222 899", "no thanks", "yes please"]);
    expect((await booking(phone))!.customerName.toLowerCase()).toContain("raju");
  });
});
