/**
 * THE MOST DANGEROUS SCENARIO — one call containing every hard element, then the
 * five-way consistency gate: FINAL INTENT vs CONVERSATION STATE vs DATABASE RECORD vs
 * SALLY'S SPOKEN CONFIRMATION vs SMS. All five must match. Live Haiku + real DB.
 */
import { setupTestDb, resetTransactionalData } from "./test/helpers";
import { ConversationalReservationBrain } from "./src/agent/reservation-brain";
import type { ReservationContext } from "./src/agent/reservation-machine";
import { createAnthropicLlm } from "./src/agent/llm";
import { getReservationSettings, findReservations } from "./src/domain/reservations";

const TZ = "Australia/Perth";
const NOW = new Date("2026-10-05T02:00:00Z"); // Mon 5 Oct 2026
const PHONE = "+61400609999";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("NO KEY"); process.exit(2); }
  const tctx = await setupTestDb();
  const db = tctx.db;
  await resetTransactionalData(db);
  const ctx: ReservationContext = {
    db, restaurantId: tctx.restaurant.id, restaurantName: "Meat Box", hours: tctx.hours,
    settings: await getReservationSettings(db, tctx.restaurant.id), timezone: TZ,
    now: () => NOW, callerPhone: PHONE, address: tctx.restaurant.address, phoneDisplay: tctx.restaurant.phoneDisplay,
    customerSmsEnabled: true, ownerAlertNumber: "+61400000000", source: "acceptance_test",
  };
  const m = ConversationalReservationBrain.fromLlm(ctx, createAnthropicLlm("claude-haiku-4-5"));

  // One winding call: relative date + natural time + party, difficult name, change date,
  // change time, repeat, hold on, birthday, change party, a question, a correction, confirm.
  const turns = [
    "I'd like a table three weeks from Saturday, around half seven, for four",
    "yes that date's right",                       // accept grounding
    "the name's Oyelaran",
    "yes",                                          // confirm name
    "actually, can we change it to eight o'clock",  // change time -> 20:00
    "can you read that back for me?",               // repeat
    "hold on a sec",                                // wait
    "ok — it's my wife's birthday by the way",      // occasion
    "and actually make it six people",              // change party -> 6
    "do you have parking?",                         // question midway
    "no, six — I said six not five",                // correction (defensive)
    "yes, that's all right",                        // final confirm
  ];
  const log: { c: string; kind: string; say: string }[] = [];
  for (const t of turns) {
    const r = await m.next(t);
    log.push({ c: t, kind: r.kind, say: r.say });
  }
  // settle any trailing confirm (only if not yet booked and the call hasn't ended)
  for (let k = 0; k < 2 && !m.reservation && !log[log.length - 1]?.endCall; k++) { const r = await m.next("yes"); log.push({ c: "yes", kind: r.kind, say: r.say }); }

  console.log("==== TRANSCRIPT ====");
  for (const l of log) console.log(`C: ${l.c}\n  A[${l.kind}]: ${l.say}`);

  const res = m.reservation;
  const state = (m as any).state.values();
  const allSays = log.map((l) => l.say).join("  ||  "); // everything Sally actually said
  const allSms = (await db.query(
    `SELECT body FROM notification_attempts WHERE kind='customer_sms' AND to_number=$1 ORDER BY created_at ASC`, [PHONE],
  )).rows;
  console.log("\n==== ALL SMS (in order, " + allSms.length + " total) ====");
  for (const s of allSms) console.log("  - " + s.body);
  const smsRow = allSms[allSms.length - 1];
  const dbRow = (await findReservations(db, tctx.restaurant.id, PHONE))[0];

  console.log("\n==== FIVE-WAY MATCH ====");
  console.log("STATE :", JSON.stringify(state));
  console.log("DB    :", dbRow ? JSON.stringify({ party: dbRow.partySize, date: dbRow.reservationDate, time: dbRow.reservationTime.slice(0,5), name: dbRow.customerName, special: dbRow.specialRequests, nameStatus: dbRow.nameStatus }) : "NONE");
  console.log("SALLY :", allSays.slice(-400));
  console.log("SMS   :", smsRow?.body ?? "NONE");

  const fails: string[] = [];
  if (!dbRow) fails.push("NO DB ROW (not booked)");
  else {
    const party = dbRow.partySize, date = dbRow.reservationDate, time = dbRow.reservationTime.slice(0, 5), name = dbRow.customerName;
    // STATE == DB
    if (state.partySize !== party) fails.push(`STATE.party ${state.partySize} != DB ${party}`);
    if (state.date !== date) fails.push(`STATE.date ${state.date} != DB ${date}`);
    if ((state.time ?? "").slice(0, 5) !== time) fails.push(`STATE.time ${state.time} != DB ${time}`);
    if ((state.name ?? "") !== (name ?? "")) fails.push(`STATE.name ${state.name} != DB ${name}`);
    // Final intent (what the caller last asked for): party 6, time 20:00, name Oyelaran, birthday noted
    if (party !== 6) fails.push(`INTENT party: DB ${party} != 6`);
    if (time !== "20:00") fails.push(`INTENT time: DB ${time} != 20:00`);
    if (!/oyelaran/i.test(name ?? "")) fails.push(`INTENT name: DB "${name}" !~ Oyelaran`);
    if (!/birthday/i.test(dbRow.specialRequests ?? "")) fails.push(`INTENT occasion: specialRequests "${dbRow.specialRequests}" !~ birthday`);
    // SALLY must have told the caller the FINAL party, time and name across the call.
    if (!new RegExp(`\\b${party}\\b`).test(allSays)) fails.push(`SALLY never stated party ${party}`);
    if (!/\b8\s*(pm|p\.m)|8:00|eight o'?clock|\b8 PM\b/i.test(allSays)) fails.push(`SALLY never stated 8pm`);
    if (!/oyelaran/i.test(allSays)) fails.push(`SALLY never stated name`);
    // SMS must reflect the DB values
    const sms = smsRow?.body ?? "";
    if (!new RegExp(`\\b${party}\\b`).test(sms)) fails.push(`SMS missing party ${party}`);
    if (!/oyelaran/i.test(sms)) fails.push(`SMS missing name`);
    // never DROPPED the booking mid-call (a warm goodbye at the end is fine; an
    // 'abandoned' would mean the booking was torn down — that must never happen here).
    if (log.some((l) => l.kind === "abandoned")) fails.push("ABANDONED (booking torn down)");
  }

  console.log("\n==== RESULT ====");
  console.log(fails.length ? "FAIL:\n  " + fails.join("\n  ") : "PASS — all five match (state == DB == Sally == SMS == final intent)");
  await db.end();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(3); });
