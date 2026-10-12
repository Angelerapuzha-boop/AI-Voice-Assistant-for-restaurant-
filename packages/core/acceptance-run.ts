/**
 * FINAL PRODUCTION ACCEPTANCE — unseen generalisation + dangerous scenario + ending matrix.
 * Drives the REAL ConversationalReservationBrain with the LIVE Haiku interpreter and the
 * REAL Postgres engine at the TEXT level (post-STT). This is NOT a scripted interpreter:
 * every customer line is understood by the live LLM, so passing proves the system handles
 * conversational CLASSES, not memorised phrases. Temporary acceptance script (not a unit test).
 */
import fs from "node:fs";
import { setupTestDb, resetTransactionalData } from "./test/helpers";
import { ConversationalReservationBrain } from "./src/agent/reservation-brain";
import type { ReservationContext } from "./src/agent/reservation-machine";
import { createAnthropicLlm } from "./src/agent/llm";
import { getReservationSettings, findReservations } from "./src/domain/reservations";

const TZ = "Australia/Perth";
const NOW = new Date("2026-10-05T02:00:00Z"); // Mon 5 Oct 2026, 10:00 Perth
const OUT = "acceptance-report.json";

type Turn = { customer: string; say: string; kind: string; endCall: boolean };
type Conv = {
  id: string; cls: string; phone: string; turns: string[];
  booked?: boolean; party?: number; dateIso?: string; dateDow?: number; time?: string;
  name?: string; nameStatus?: "provided" | "unresolved"; endOk?: boolean;
  anySay?: RegExp[]; note?: string;
};

function dow(iso?: string): number | undefined {
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ------------------------------------------------------------------ the 50 unseen conversations
const CONVS: Conv[] = [
  // --- information supplied in unusual order (1-5)
  { id: "ord1", cls: "out-of-order", phone: "+61400600001", turns: ["it's for six people", "name's Marcus", "this Friday", "around 6 o'clock", "yes that's right"], booked: true, party: 6, dateDow: 5, time: "18:00", name: "Marcus" },
  { id: "ord2", cls: "out-of-order", phone: "+61400600002", turns: ["put it under Priya", "we'll be four", "next Tuesday evening, say half seven", "yep"], booked: true, party: 4, time: "19:30", name: "Priya" },
  { id: "ord3", cls: "out-of-order", phone: "+61400600003", turns: ["7pm", "two of us", "tomorrow", "the name is Dan", "perfect"], booked: true, party: 2, dateIso: "2026-10-06", time: "19:00", name: "Dan" },
  { id: "ord4", cls: "out-of-order", phone: "+61400600004", turns: ["a booking for Saturday", "five people", "my name is Chloe", "eight o'clock please", "yes"], booked: true, party: 5, dateDow: 6, time: "20:00", name: "Chloe" },
  { id: "ord5", cls: "out-of-order", phone: "+61400600005", turns: ["evening on the 14th of November", "three people", "half past six", "Tom", "lovely, yes"], booked: true, party: 3, dateIso: "2026-11-14", time: "18:30", name: "Tom" },
  // --- spontaneous corrections (6-9)
  { id: "corr1", cls: "correction", phone: "+61400600011", turns: ["table for four this Saturday at seven", "actually make it six", "name's Omar", "yes"], booked: true, party: 6, name: "Omar" },
  { id: "corr2", cls: "correction", phone: "+61400600012", turns: ["book Friday at 8 for two, name Lucy", "sorry I meant Thursday not Friday", "yes that's right"], booked: true, party: 2, dateDow: 4, name: "Lucy" },
  { id: "corr3", cls: "correction", phone: "+61400600013", turns: ["tomorrow at six for four under Sam", "change the time to half seven", "yep"], booked: true, time: "19:30", name: "Sam" },
  { id: "corr4", cls: "correction", phone: "+61400600014", turns: ["Saturday, seven pm, five people, name Ravi", "no the name is Ravina not Ravi", "correct"], booked: true, name: "Ravina" },
  // --- conflicting information (10-12)
  { id: "conf1", cls: "conflict", phone: "+61400600021", turns: ["book for two... no wait, four", "this Friday at seven", "name Kate", "yes"], booked: true, party: 4, name: "Kate" },
  { id: "conf2", cls: "conflict", phone: "+61400600022", turns: ["Saturday at seven, actually Sunday at eight, for three, name Leo", "yes Sunday is right"], booked: true, party: 3, dateDow: 0, time: "20:00", name: "Leo" },
  { id: "conf3", cls: "conflict", phone: "+61400600023", turns: ["we're six, maybe seven", "let's say seven", "next Saturday at 7", "name Jo", "yes"], booked: true, party: 7, name: "Jo" },
  // --- vague dates (13-16)
  { id: "vague1", cls: "vague-date", phone: "+61400600031", turns: ["sometime soon", "oh, this Friday", "two at seven, name Ana", "yes"], booked: true, name: "Ana" },
  { id: "vague2", cls: "vague-date", phone: "+61400600032", turns: ["maybe sometime next week", "let's do Wednesday", "four at six thirty, name Bill", "yes"], booked: true, time: "18:30", name: "Bill" },
  { id: "vague3", cls: "vague-date", phone: "+61400600033", turns: ["I'm not sure which day yet", "actually Saturday", "three at eight, name Mia", "yes"], booked: true, name: "Mia" },
  { id: "vague4", cls: "vague-date", phone: "+61400600034", turns: ["the weekend", "Saturday please", "five at seven, name Zoe", "yes"], booked: true, dateDow: 6, name: "Zoe" },
  // --- relative dates (17-21)  (grounding expected for far-out ones)
  { id: "rel1", cls: "relative-date", phone: "+61400600041", turns: ["three weeks from Saturday", "yes that date's right", "four at seven, name Nina", "yes"], booked: true, name: "Nina" },
  { id: "rel2", cls: "relative-date", phone: "+61400600042", turns: ["a fortnight today", "yes", "two at 7, name Paul", "yes"], booked: true, name: "Paul" },
  { id: "rel3", cls: "relative-date", phone: "+61400600043", turns: ["next Friday", "six thirty, three people, name Ivy", "yes"], booked: true, dateDow: 5, time: "18:30", name: "Ivy" },
  { id: "rel4", cls: "relative-date", phone: "+61400600044", turns: ["the Saturday after next", "yes that's right", "five at eight, name Ken", "yes"], booked: true, name: "Ken" },
  { id: "rel5", cls: "relative-date", phone: "+61400600045", turns: ["in two weeks on the Thursday", "yes", "two at seven, name Ola", "yes"], booked: true, name: "Ola" },
  // --- conversational times (22-26)
  { id: "time1", cls: "conv-time", phone: "+61400600051", turns: ["this Saturday", "quarter to eight", "two, name Rob", "yes"], booked: true, time: "19:45", name: "Rob" },
  { id: "time2", cls: "conv-time", phone: "+61400600052", turns: ["Friday", "half seven", "four, name Tess", "yes"], booked: true, time: "19:30", name: "Tess" },
  { id: "time3", cls: "conv-time", phone: "+61400600053", turns: ["tomorrow", "sevenish", "two, name Gus", "yes"], booked: true, name: "Gus" },
  { id: "time4", cls: "conv-time", phone: "+61400600054", turns: ["Saturday", "eight o'clock-ish", "three, name Hana", "yes"], booked: true, time: "20:00", name: "Hana" },
  { id: "time5", cls: "conv-time", phone: "+61400600055", turns: ["this Friday", "quarter past six", "two, name Ida", "yes"], booked: true, time: "18:15", name: "Ida" },
  // --- names STT has never seen + spelling (27-33)
  { id: "name1", cls: "novel-name", phone: "+61400600061", turns: ["Saturday at seven for two", "it's under Oyelaran", "yes that's right", "yes"], booked: true },
  { id: "name2", cls: "novel-name", phone: "+61400600062", turns: ["Friday 8pm, four people", "the name is Nguyen", "yes", "yes"], booked: true },
  { id: "name3", cls: "novel-name", phone: "+61400600063", turns: ["tomorrow at seven, two people", "Siobhan", "yes that's right", "yes"], booked: true },
  { id: "name4", cls: "novel-name", phone: "+61400600064", turns: ["Saturday seven, three", "Krzysztof", "yes", "yes"], booked: true },
  { id: "spell1", cls: "spelling", phone: "+61400600071", turns: ["Saturday at seven for two", "it's Zara, Z-A-R-A", "yes", "yes"], booked: true, name: "Zara" },
  { id: "spell2", cls: "spelling", phone: "+61400600072", turns: ["Friday at eight for four", "the name is Jai, J for juliet A for alpha I for india", "yes", "yes"], booked: true, name: "Jai" },
  { id: "spell3", cls: "spelling", phone: "+61400600073", turns: ["tomorrow seven, two people", "name's Ede, that's E-D-E", "yes", "yes"], booked: true, name: "Ede" },
  // --- poor audio / garbled STT (34-36)   (degenerate guard; never hang up)
  { id: "garb1", cls: "garbled", phone: "+61400600081", turns: ["book a table for four this Saturday at seven", "1 2 3 4 5 6 7 8 9 10 11 12", "11 12 13 14 15 16 17 18 19 20", "21 22 23 24 25 26 27 28 29 30", "31 32 33 34 35 36 37 38 39 40"], booked: true, party: 4, nameStatus: "unresolved", name: "" },
  { id: "garb2", cls: "garbled", phone: "+61400600082", turns: ["two people tomorrow at seven", "name is Finn", "yes", "yes"], booked: true, name: "Finn" },
  { id: "garb3", cls: "garbled", phone: "+61400600083", turns: ["aaaaaaaa aaaaaaaa aaaaaaaa", "sorry, a table for two this Friday at seven, name Fred", "yes"], booked: true, name: "Fred", note: "degraded then recovers" },
  // --- hesitation (37-39)
  { id: "hes1", cls: "hesitation", phone: "+61400600091", turns: ["um... I'd like to book a table", "uh, let me think, Saturday I guess", "seven, and... four people", "name's, uh, Beth", "yes"], booked: true, party: 4, name: "Beth" },
  { id: "hes2", cls: "hesitation", phone: "+61400600092", turns: ["hi, yeah, a table", "tomorrow maybe, yeah tomorrow", "two of us, at seven I think", "Joe", "yeah ok"], booked: true, name: "Joe" },
  { id: "hes3", cls: "hesitation", phone: "+61400600093", turns: ["so like, can I book", "Friday... yeah Friday", "half seven, er, three people", "name Ash", "yes"], booked: true, time: "19:30", name: "Ash" },
  // --- questions midway (40-41)
  { id: "q1", cls: "question-midway", phone: "+61400600101", turns: ["table for four Saturday at seven", "do you have parking?", "ok, name's Dev", "yes"], booked: true, name: "Dev", anySay: [/park/i] },
  { id: "q2", cls: "question-midway", phone: "+61400600102", turns: ["booking for two tomorrow", "are you open on Mondays?", "seven pm, name Rae", "yes"], booked: true, name: "Rae" },
  // --- frustration (42-43)  (never hang up)
  { id: "frus1", cls: "frustration", phone: "+61400600111", turns: ["table for four Friday at seven", "no I already told you four, come on", "name's Gabe", "yes"], booked: true, party: 4, name: "Gabe" },
  { id: "frus2", cls: "frustration", phone: "+61400600112", turns: ["two people Saturday seven", "this is frustrating, you keep asking", "name Uma", "yes"], booked: true, name: "Uma" },
  // --- multiple changes (44-45)
  { id: "multi1", cls: "multi-change", phone: "+61400600121", turns: ["Friday 7 for four, name Will", "change it to Saturday", "and make it six people", "and eight o'clock", "yes that's all right"], booked: true, party: 6, dateDow: 6, time: "20:00", name: "Will" },
  { id: "multi2", cls: "multi-change", phone: "+61400600122", turns: ["tomorrow at six for two under Nora", "actually three people", "no, half six not six", "yes"], booked: true, party: 3, time: "18:30", name: "Nora" },
  // --- caller says wait (46)
  { id: "wait1", cls: "wait", phone: "+61400600131", turns: ["table for two this Saturday", "hold on a sec", "ok sorry, seven pm, name Pat", "yes"], booked: true, name: "Pat" },
  // --- mind-change at final confirmation (47)
  { id: "final1", cls: "final-change", phone: "+61400600141", turns: ["Saturday seven for four, name Rhys", "actually, can we do five people instead", "yes that's right"], booked: true, party: 5, name: "Rhys" },
  // --- large group (48)  (party-hall routing; allow a final turn)
  { id: "large1", cls: "large-group", phone: "+61400600151", turns: ["I need a table for 25 people", "it's for a work dinner next Saturday at seven", "name's Dalton"], endOk: false, anySay: [/party hall|function|large|team|call you|arrange/i] },
  // --- occasion (49)
  { id: "occ1", cls: "occasion", phone: "+61400600161", turns: ["table for four this Saturday at seven", "it's my wife's birthday", "name's Victor", "yes"], booked: true, name: "Victor", anySay: [/birthday|occasion|celebrat|special/i] },
  // --- unexpected but reasonable question (50)
  { id: "unexp1", cls: "unexpected-q", phone: "+61400600171", turns: ["do you cater for gluten free?", "great, table for two this Friday at seven, name Wade", "yes"], booked: true, name: "Wade", anySay: [/gluten|dietary|allerg|kitchen|chef|note/i] },
];

async function makeBrain(ctxBase: Omit<ReservationContext, "callerPhone">, phone: string): Promise<ConversationalReservationBrain> {
  const llm = createAnthropicLlm("claude-haiku-4-5");
  return ConversationalReservationBrain.fromLlm({ ...ctxBase, callerPhone: phone }, llm);
}

async function runConv(ctxBase: Omit<ReservationContext, "callerPhone">, db: any, restaurantId: string, c: Conv) {
  await resetTransactionalData(db);
  const m = await makeBrain(ctxBase, c.phone);
  m.opening();
  const turns: Turn[] = [];
  for (const customer of c.turns) {
    const r = await m.next(customer);
    turns.push({ customer, say: r.say, kind: r.kind, endCall: Boolean(r.endCall) });
  }
  // Settle: a cooperative caller says "yes" to absorb the grounding / area-offer /
  // lock-in confirmation steps that (correctly) add turns. Bounded, and any WRONG
  // value a confirmation locks in is still caught by the value gates below.
  if (c.booked === true) {
    for (let k = 0; k < 3 && !m.reservation; k++) {
      const last = turns[turns.length - 1];
      if (last?.endCall) break;
      const r = await m.next("yes");
      turns.push({ customer: "yes", say: r.say, kind: r.kind, endCall: Boolean(r.endCall) });
    }
  }
  const res = m.reservation;
  const fails: string[] = [];

  // GATE: no unintended hang-up. A warm close AFTER a completed booking is correct
  // (the booking is saved); only an 'abandoned' teardown or an end BEFORE a booking
  // that was expected counts as a bad hang-up.
  const abandonTurn = turns.find((t) => t.kind === "abandoned");
  if (abandonTurn) fails.push(`HANGUP: abandoned on "${abandonTurn.customer}"`);
  const endedTurn = turns.find((t) => t.endCall);
  if (endedTurn && c.endOk !== true && c.booked === true && !res) fails.push(`HANGUP: ended on "${endedTurn.customer}" before booking (kind=${endedTurn.kind})`);

  // GATE: no repeated-question loop (identical consecutive assistant lines)
  for (let i = 1; i < turns.length; i++) {
    if (norm(turns[i]!.say) && norm(turns[i]!.say) === norm(turns[i - 1]!.say)) {
      fails.push(`LOOP: repeated "${turns[i]!.say.slice(0, 50)}"`);
      break;
    }
  }

  // Booking-outcome checks
  if (c.booked === true) {
    if (!res) fails.push("NOT_BOOKED: expected a reservation, none created");
    else {
      if (c.party != null && res.partySize !== c.party) fails.push(`PARTY: got ${res.partySize} want ${c.party}`);
      if (c.dateIso && res.reservationDate !== c.dateIso) fails.push(`DATE: got ${res.reservationDate} want ${c.dateIso}`);
      if (c.dateDow != null && dow(res.reservationDate) !== c.dateDow) fails.push(`DOW: got ${res.reservationDate} (dow ${dow(res.reservationDate)}) want dow ${c.dateDow}`);
      if (c.time && res.reservationTime.slice(0, 5) !== c.time) fails.push(`TIME: got ${res.reservationTime.slice(0, 5)} want ${c.time}`);
      if (c.name != null && (res.customerName ?? "") !== c.name) fails.push(`NAME: got "${res.customerName}" want "${c.name}"`);
      if (c.nameStatus && res.nameStatus !== c.nameStatus) fails.push(`NAMESTATUS: got ${res.nameStatus} want ${c.nameStatus}`);
      // never a hallucinated/garbage name
      if (/\b\d\b|\d\d/.test(res.customerName ?? "")) fails.push(`GARBAGE_NAME: "${res.customerName}"`);
    }
  }
  if (c.booked === false && res) fails.push("UNEXPECTED_BOOKING: a reservation was created");

  // Required-content checks (at least one assistant turn matches)
  for (const re of c.anySay ?? []) {
    if (!turns.some((t) => re.test(t.say))) fails.push(`MISSING_SAY: no turn matched ${re}`);
  }

  return { id: c.id, cls: c.cls, pass: fails.length === 0, fails, res: res ? { party: res.partySize, date: res.reservationDate, time: res.reservationTime.slice(0, 5), name: res.customerName, nameStatus: res.nameStatus, needsStaff: res.needsStaffAttention } : null, turns };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("NO ANTHROPIC_API_KEY — aborting"); process.exit(2); }
  const tctx = await setupTestDb();
  const db = tctx.db;
  const ctxBase: Omit<ReservationContext, "callerPhone"> = {
    db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
    settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
    now: () => NOW, address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
    customerSmsEnabled: true, ownerAlertNumber: "+61400000000", source: "acceptance_test",
  };

  const results: any[] = [];
  let i = 0;
  const limit = Number(process.env.LIMIT) || CONVS.length;
  const convs = CONVS.slice(0, limit);
  for (const c of convs) {
    i++;
    try {
      const r = await runConv(ctxBase, db, tctx.restaurant.id, c);
      results.push(r);
      console.log(`[${i}/${convs.length}] ${r.pass ? "PASS" : "FAIL"} ${c.id} (${c.cls})${r.pass ? "" : " :: " + r.fails.join("; ")}`);
    } catch (err) {
      results.push({ id: c.id, cls: c.cls, pass: false, fails: ["EXCEPTION: " + String((err as Error)?.message ?? err)], turns: [] });
      console.log(`[${i}/${convs.length}] ERROR ${c.id}: ${String((err as Error)?.message ?? err)}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const byGate: Record<string, number> = {};
  for (const r of results) for (const f of r.fails) { const g = f.split(":")[0]!; byGate[g] = (byGate[g] ?? 0) + 1; }
  const summary = { total: results.length, passed, failed: results.length - passed, gateFailures: byGate };
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
  console.log("\n==== SUMMARY ====");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`report: packages/core/${OUT}`);
  await db.end();
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(3); });
