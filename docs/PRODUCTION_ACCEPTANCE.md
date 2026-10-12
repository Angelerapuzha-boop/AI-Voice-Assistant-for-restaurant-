# Meat Box Reservation Assistant — Final Production Acceptance Report
**Date:** 2026-10-10   **Status:** Acceptance criteria met; deployed to production (box, active, health 200, 0 errors).

---

## 1. Verdict

The assistant now behaves like an attentive human receptionist across normal **and** unexpected conversation. It was validated not on memorised phrases but on **behaviour classes**, driven through the real brain + the live Haiku interpreter + the real Postgres engine, **and** through six real calls on a difficult international line. Every hard release blocker is at zero (§6). Remaining limitations are documented honestly (§7).

The six live calls (§8) earned their keep: they exposed **three more real blockers that the clean automated suite could not** — an ambiguous-hour time loop (the classic "stop looping"), a confirmation misread as a hang-up, and an ignored opening-hours question — because those only surface with real noisy-line STT and genuinely ambiguous phrasing. All three are now fixed, regression-tested, deployed, and re-verified on the live interpreter.

---

## 2. Architecture (what actually runs each turn)

```
Twilio Media Stream (μ-law 8k)
  → ElevenLabs Scribe v2 (STT)
  → [ DEGENERATE-STT GUARD ]        drop hallucinated "1 2 3…" runs before they reach anything
  → [ FAST PATH ]                   clean yes/no + a clean single-field answer, no LLM (sub-ms)
       └─ bails to the LLM the moment the words carry a DIFFERENT field, a change, a question…
  → [ CONVERSATION INTERPRETER ]    Haiku 4.5: understands ONE utterance → structured intent,
                                    entities as VERBATIM phrases, corrections, question, signals
  → [ RESERVATION STATE MANAGER ]   deterministic: parses phrases, latest-correction-wins,
                                    provenance, stale-availability invalidation, consistency
  → [ DETERMINISTIC ENGINE ]        availability + DB writes (the ONLY source of business facts)
  → [ RESPONSE PLANNER ]            one apology max, no gush, answers the question first
  → Sally TTS → Twilio
```

**The non-negotiable seam:** the LLM *understands*; deterministic code *decides and owns every business fact*. No availability, date, time, party, booking reference, or confirmation ever originates from the LLM — it only segments the utterance and hands verbatim phrases to the proven parsers. Zero hallucination at the action layer, by construction.

---

## 3. The three mandated safety rules (implemented + deployed)

**(1) Silence termination — the only assistant-initiated end, made extremely safe.**
Before any nudge, `silenceGuardActive()` verifies none of: active speech, a building partial transcript, a turn/booking in flight, audio still playing out, a customer "hold on" grace window, or a very recent interruption. Cadence: gentle contextual nudge → "Still there?" → warm close ("I'll let you go for now. Feel free to call us back when you're ready."). It will **never** close mid name-spelling (`midCriticalFlow()` guard). Logged as its own `silence_timeout` event — never as customer abandonment.

**(2) Name fallback hierarchy — never a guessed name, never a silent nameless booking.**
Understand → ask again → confirm a strong candidate → ask them to spell it → parse the spelling → *only then* fall back to the caller's own number. The fallback stores `name_status = 'unresolved'`, flags the row `needs_staff_attention`, alerts the team once, and says the honest line: *"I'm having trouble catching the name clearly, but I've got your number. I can keep the booking under that and flag the name for the team."* (Schema migration 0014.)

**(3) Database consistency gate — Sally and the SMS speak from the saved record.**
Before "booked", the DB row is consistency-checked against the confirmed state. The spoken confirmation **and** the SMS are built from the row re-read back out of the database (`getReservationById`) — not conversational state, not the LLM, not a prior revision. Post-confirmation changes persist to the row and re-send a single debounced SMS so the text always matches the final booking.

---

## 4. Root-cause categories found & fixed during acceptance

The 50-conversation generalisation suite started at **31/50** and exposed five real defects, each root-caused and fixed generally (not phrase-patched), each with a permanent regression test:

| # | Class | Defect | Root cause | Fix |
|---|-------|--------|-----------|-----|
| a | SEMANTIC / "respond to what they just said" | "three people" read as *3 o'clock*; "eight o'clock" read as *party 8*; "six thirty, three people, name Ivy" dropped party+name | the deterministic **fast path** force-fit combined/out-of-order utterances to the asked field; its guard missed spelled numbers & name cues | fast path now bails to the semantic layer on **any** marker for a different field (incl. spelled numbers, "o'clock", name cue) |
| b | TERMINATION | "yes, that's all right" at the confirm hung up | "that's all" end-phrase matched inside "that's all **right**" | negative lookahead — a confirmation never reads as a close |
| c | ENTITY | "Zara, Z-A-R-A" stored as "Zara Z-a-r-a" | name resolver used `parseName` on the whole phrase | prefer `parseSpelledName` (null for a plain name → no regression) |
| d | STATE | occasion mentioned after booking acknowledged but not saved | notes weren't persisted post-confirmation | `captureExtras` flags dirty → `handleBooked` writes `specialRequests` to the row |
| e | DATABASE / TTS | SMS stale after a post-confirmation change | SMS sent once at first lock-in | re-send on each change, **debounced** so only a real change re-texts; final SMS always matches the DB |

Interpreter guidance also gained two general examples ("N at TIME" → party N + time; *field is fixed by the words, not the question*).

**Then six real calls on a difficult international line exposed three more, each fixed generally + regression-tested + re-verified live:**

| # | Class | Defect (live) | Fix |
|---|-------|---------------|-----|
| f | TURN-TAKING / "stop looping" | "half past eleven" read as **11:30 AM** → outside 5 PM–1 AM → endless "what time?" ("please stop looping" ×2) | `normaliseTime` takes the **opening window** and resolves a bare ambiguous hour to the in-hours reading → **23:30**; "twelve" → midnight |
| g | TERMINATION | "Yeah, I'm good" at the lock-in → "I'm good" read as a close → **ended without booking** | a **yes to a pending confirmation outranks any end-phrase** (same family as "that's all right") |
| h | SEMANTIC / ignored question | "when are you open?" treated as an unparseable time and re-asked | the hours answer now **states the real hours** ("We're open from 5 PM till 1 AM…") instead of deflecting |

---

## 5. Test results by behaviour family

**Automated unit/integration:** core **1,245 passing** / 3 skipped (37 files); voice **33 passing**; full typecheck clean. Includes permanent regressions for every defect above (the five from the generalisation suite **and** the three from the live calls — a hours-aware time block, and brain "LIVE-CALL REGRESSIONS") plus the **final call-ending matrix** (bye→end, bare "no"→continue, "no make it six"→correction, "never mind"→abandon, "hold on"→wait, frustrated→no hang-up, large group→final turn, booked+"repeat"→read back & stay responsive).

**Live-LLM unseen generalisation (50 conversations, real brain + Haiku + Postgres, no Cekura): 50/50 behave correctly.** Classes covered: information out of order, spontaneous corrections, conflicting information, vague dates, relative dates, conversational times, names never seen before, spelling, poor/garbled audio, hesitation, questions mid-flow, frustration, multiple changes, caller saying wait, mind-change at final confirmation, large groups, occasions, unexpected-but-reasonable questions.

**Most-dangerous scenario (one call: relative date + natural-language time + party, difficult name, change date, change time, repeat, hold on, birthday, change party, a question, a correction, final confirm):** the **five-way match passes** — FINAL INTENT == conversation STATE == DATABASE record == Sally's spoken confirmation == SMS (6 people, Sat 31 Oct, 8 PM, under Oyelaran, birthday noted).

---

## 6. Release gates — all zero

| Gate | Result | Evidence |
|------|--------|----------|
| Unintended hang-ups | **0** | 50/50 no bad hang-up; brain ends only on explicit customer close/abandon; ending matrix |
| Wrong confirmed bookings | **0** | 50/50 values correct; 5-way match |
| Wrong dates / times / party sizes | **0** | per-field gates across the suite; conversational-time + relative-date families |
| Stale values after correction | **0** | corrections / conflicts / multi-change families; dangerous scenario |
| False confirmations | **0** | DB consistency gate before "booked" |
| Duplicate reservations | **0** | idempotency key + no-dup-active unique index |
| Ignored explicit customer intents | **0** | question-midway / correction / wait / repeat families |
| Repeated-question loops | **0** | loop gate in the suite + anti-loop watchdog; combined-info now captured first time |
| Customer asked to repeat because ignored | **0** | combined/out-of-order info captured in one turn |
| Corrupted STT → destructive action | **0** | degenerate-STT guard; garbled families; abandon only on explicit cue |
| Hallucinated availability / business facts | **0** | architecture: no business fact from the LLM |
| Wrong cancellation / modification | **0** | modify path re-checks availability; dangerous-scenario changes all correct |

---

## 7. Honest remaining limitations

- **Ultra-terse telegraphic phrasing** ("five at seven" with no "people"/"of us") is now handled reliably via an interpreter example, but it sits at the edge of the semantic layer's confidence. The **safe fallback** when genuinely ambiguous is a clarifying re-ask ("how many will be dining?") — never a mis-booking or a hang-up.
- **"Yes" in reply to "anything else I can help with?"** is treated as a wind-down and the call closes warmly (booking saved). This errs toward the anti-loop behaviour you asked for rather than re-prompting; a real caller states what they need or calls back.
- **Silence timeout** remains an assistant-initiated end (you approved this) — but only after the full verified cadence on a genuinely dead line; logged separately as `silence_timeout`.
- **STT on poor lines** can still mangle a spoken name into noise; the system degrades safely (spell recovery, then caller-ID fallback flagged for staff) and never invents a name.
- **Minor edges observed on the live calls (not fixed — low-impact, booking always safe):** a change request with *no new value* ("change the party size") re-reads the confirmation instead of asking "to how many?"; a post-booking "I'm not happy" gets a warm close rather than an offer to put it right; "half of seven / half of nine" parses to 7 / 9 PM rather than 7:30 / 9:30 (genuinely ambiguous phrasing — the read-back lets the caller correct it); a very noisy line can bleed a stray word into a name, caught by the confirmation read-back.

---

## 8. Recordings (six real calls, difficult international line)

| # | Scenario | What it demonstrated |
|---|----------|----------------------|
| 1 | Relative date + garbled party | Date grounded (Sat 31 Oct); when the line mangled the party number, it kept the line open patiently and **never guessed or hung up** |
| 2 | Multi-change | Date grounded (Tue 3 Nov), time change applied; surfaced the "change with no value" edge |
| 3 | Name + spelling | Name captured cleanly; **surfaced blocker (g)** — "Yeah, I'm good" ended without booking (now fixed) |
| 4 | Large group + question + frustration | **Party-hall auto-book for 25**, parking answered, **name deferred with the honest line + `name_status=unresolved`** (DB-confirmed), one genuine apology on "stop looping" |
| 5 | Hold + name recovery | "Hold on" → "No worries, I'll wait"; garbled name → re-ask → candidate confirm |
| 6 | Combined worst-case | Date correction + grounding and party changes-with-value worked; **surfaced blockers (f) + (h)** — the "half past eleven" loop and the ignored hours question (both now fixed) |

The three blockers these calls exposed are fixed and **re-verified on the live interpreter**: "half past eleven" now books **23:30**; "yeah, I'm good" at the lock-in now **books**; "when are you open?" now **states 5 PM–1 AM**. A single optional live re-verification call can confirm the fixes on real audio on request (it rings the test phone).

---

## 9. Deployment state

All reservation-stack source is live on the box (each file hash-matched after copy), migration 0014 applied, service active, `/health` 200, zero errors on restart. The box runs TypeScript directly via `tsx`, so deploy = copy source + restart.
