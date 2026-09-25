// Full-dialogue regression battery — drives realistic, messy caller dialogues
// across the whole menu through the REAL engine and asserts they complete on
// the deterministic fast path (no slow LLM turn) with the correct order. Guards
// against the "natural speech falls to the LLM / One sec" regression Kevin hit
// on his live AU-number test (2026-09-18).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import type { Llm, LlmStreamEvent } from "../src/agent/llm";
import { getOrderWithItems } from "../src/domain/orders";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";

let ctx: TestContext;
let db: pg.Pool;
beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });

/** Records how often it is reached; returns the scenario's assumed assistant
 * line so staging stays realistic even across a (permitted) LLM turn. */
class StubLlm implements Llm {
  hits = 0;
  nextReply = "Anything else?";
  stream(): AsyncIterable<LlmStreamEvent> {
    this.hits++;
    const reply = this.nextReply;
    return (async function* () {
      yield { type: "text", text: reply } as LlmStreamEvent;
      yield { type: "stop", reason: "end_turn" } as LlmStreamEvent;
    })();
  }
}

function agentCtx(): AgentContext {
  return {
    db, restaurant: ctx.restaurant,
    settings: { ...ctx.settings, customerSmsEnabled: true },
    hours: ctx.hours, callerNumber: "+61400000001",
    now: () => new Date("2026-09-09T19:00:00+08:00"), // Wednesday, kitchen open
  };
}

type Turn = { caller: string; then?: string };
interface Result { llmTurns: number; items: string[]; name: string; detail: string[] }

async function drive(turns: Turn[]): Promise<Result> {
  const stub = new StubLlm();
  const agent = new OrderAgent(stub, agentCtx());
  agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
  let llmTurns = 0;
  for (const t of turns) {
    stub.nextReply = t.then ?? "Anything else?";
    const before = stub.hits;
    await agent.handleTurn(t.caller);
    if (stub.hits > before) llmTurns++;
  }
  const order = agent.state.draftOrderId ? await getOrderWithItems(db, agent.state.draftOrderId) : null;
  const items = (order?.items ?? [])
    .map((i) => `${i.quantity}x ${i.nameSnapshot}`)
    .sort();
  const detail = (order?.items ?? []).map(
    (i) => `${i.quantity}x ${i.nameSnapshot} [${i.modifiers.map((m) => m.nameSnapshot).sort().join(", ")}]` +
      `${i.removals.length ? ` no:${[...i.removals].sort().join(",")}` : ""}`,
  );
  return { llmTurns, items, name: order?.customerName ?? "", detail };
}

describe("full-dialogue battery (fast path, no LLM)", () => {
  it("A: chicken meatbox + base, proactive 'what sauces?', name lead-in", async () => {
    const r = await drive([
      { caller: "yeah can I grab a chicken meatbox" },
      { caller: "chips and salad" },
      { caller: "what sauces do you have?" },
      { caller: "garlic and bbq" },
      { caller: "that's it" },
      { caller: "it's for Kevin" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Meatbox"]);
    expect(r.name).toBe("Kevin");
  });

  it("B: small meatbox (meat + base both required)", async () => {
    const r = await drive([
      { caller: "a small meatbox" },
      { caller: "chicken" },
      { caller: "rice and salad" },
      { caller: "nah that's the lot" },
      { caller: "Sam" },
      { caller: "yeah go on" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Small Meatbox"]);
    expect(r.name).toBe("Sam");
  });

  it("C: kebab (jumbled words) + 'what salads?' + 'all of them' + drink", async () => {
    const r = await drive([
      { caller: "I'd like a takeaway kebab, chicken" },
      { caller: "actually what salads have you got" },
      { caller: "all of them" },
      { caller: "and a coke" },
      { caller: "that's everything" },
      { caller: "Dave" },
      { caller: "perfect" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Kebab", "1x Soft Drink Can"]);
    expect(r.name).toBe("Dave");
  });

  it("D: bare intent opener + quantity + mid-order swap", async () => {
    const r = await drive([
      { caller: "hi I want to place an order" },
      { caller: "can I get two lamb meatboxes" },
      { caller: "chips and salad on both" },
      { caller: "make one of them a chicken one" },
      { caller: "no that's me" },
      { caller: "under Jess" },
      { caller: "yes correct" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Meatbox", "1x Lamb Meatbox"]);
    expect(r.name).toBe("Jess");
  });

  it("E: drink by flavour + option change", async () => {
    const r = await drive([
      { caller: "a chicken kebab" },
      { caller: "a can of coke" },
      { caller: "actually make it a fanta" },
      { caller: "nothing else" },
      { caller: "Tom" },
      { caller: "yep that's right" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Kebab", "1x Soft Drink Can"]);
    expect(r.name).toBe("Tom");
  });

  it("G: 'a couple of', base on both, sweet chilli on both", async () => {
    const r = await drive([
      { caller: "gday, a couple of chicken meatboxes thanks" },
      { caller: "rice and salad on both" },
      { caller: "sweet chilli on both" },
      { caller: "that'll be it" },
      { caller: "Marco" },
      { caller: "spot on" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["2x Chicken Meatbox"]);
    expect(r.name).toBe("Marco");
  });

  it("H: charcoal chicken (spoken without 'Meal'), sauces-only optional group", async () => {
    const r = await drive([
      { caller: "half charcoal chicken please" },
      { caller: "what sauces have you got" },
      { caller: "just garlic" },
      { caller: "no that's it" },
      { caller: "for Dan" },
      { caller: "yep confirm" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Half Charcoal Chicken Meal"]);
    expect(r.name).toBe("Dan");
  });

  // --- corrections & twisted phrasing (Kevin: "fix all twisted sentences /
  // changing of sentences / gaps / one sec") ---

  it("K: ingredient removals ('no onion', 'without pickles')", async () => {
    const r = await drive([
      { caller: "can I get a chicken kebab" },
      { caller: "lettuce and tomato" },
      { caller: "no onion" },
      { caller: "without pickles" },
      { caller: "that's it" },
      { caller: "Ivan" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.detail).toEqual(["1x Chicken Kebab [Lettuce, Tomato] no:onion,pickles"]);
    expect(r.name).toBe("Ivan");
  });

  it("L: cancel one line, keep the rest", async () => {
    const r = await drive([
      { caller: "a chicken kebab" },
      { caller: "and a can of coke" },
      { caller: "actually cancel the coke" },
      { caller: "that's everything" },
      { caller: "Nia" },
      { caller: "yes" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Kebab"]);
    expect(r.name).toBe("Nia");
  });

  it("M: quantity change on the sole line ('actually make it two')", async () => {
    const r = await drive([
      { caller: "a chicken meatbox" },
      { caller: "chips and salad" },
      { caller: "actually make it two" },
      { caller: "nah that's the lot" },
      { caller: "Owen" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["2x Chicken Meatbox"]);
    expect(r.name).toBe("Owen");
  });

  it("N: twisted phrasing ('one of those chicken meatbox things')", async () => {
    const r = await drive([
      { caller: "yeah um can I get like one of those chicken meatbox things" },
      { caller: "chips and salad" },
      { caller: "that's it" },
      { caller: "Ravi" },
      { caller: "good to go" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Meatbox"]);
    expect(r.name).toBe("Ravi");
  });

  it("O: clear the whole order, then reorder", async () => {
    const r = await drive([
      { caller: "a lamb kebab" },
      { caller: "actually scrap the whole order" },
      { caller: "a chicken kebab" },
      { caller: "no that's it" },
      { caller: "Zed" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Kebab"]);
    expect(r.name).toBe("Zed");
  });

  it("P: remove a selected sauce ('actually no chilli')", async () => {
    const r = await drive([
      { caller: "a chicken kebab" },
      { caller: "garlic and chilli" },
      { caller: "actually no chilli" },
      { caller: "that's the lot" },
      { caller: "Pia" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.detail).toEqual(["1x Chicken Kebab [Garlic sauce]"]);
    expect(r.name).toBe("Pia");
  });

  it("R: 'remove the onion' drops the ingredient, NOT the whole kebab", async () => {
    const r = await drive([
      { caller: "a chicken kebab" },
      { caller: "lettuce, tomato and onion" },
      { caller: "remove the onion" },
      { caller: "that's it" },
      { caller: "Kim" },
      { caller: "yep" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.detail).toEqual(["1x Chicken Kebab [Lettuce, Tomato]"]);
    expect(r.name).toBe("Kim");
  });

  it("Q: social opener + twisted item + swap + drink + cancel, all deterministic", async () => {
    const r = await drive([
      { caller: "gday mate, how ya going" },
      { caller: "can I grab a couple of them lamb meatbox things" },
      { caller: "rice and salad on both" },
      { caller: "actually make one a chicken one" },
      { caller: "and chuck a coke in there" },
      { caller: "nah actually cancel the coke" },
      { caller: "that'll do" },
      { caller: "it's under Sami" },
      { caller: "perfect" },
    ]);
    expect(r.llmTurns).toBe(0);
    expect(r.items).toEqual(["1x Chicken Meatbox", "1x Lamb Meatbox"]);
    expect(r.name).toBe("Sami");
  });
});
