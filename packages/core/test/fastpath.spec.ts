import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import { isFinished, isYes, spokenClose, terseReadback } from "../src/agent/fastpath";
import { addOrderItem, createDraft, getOrderWithItems } from "../src/domain/orders";
import type { Llm } from "../src/agent/llm";
import {
  findItemByName,
  modifierId,
  resetTransactionalData,
  setupTestDb,
  type TestContext,
} from "./helpers";

let ctx: TestContext;
let db: pg.Pool;

beforeAll(async () => {
  ctx = await setupTestDb();
  db = ctx.db;
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await resetTransactionalData(db);
});

/** An LLM that must never be reached — proves the fast path handled it. */
const FORBIDDEN_LLM: Llm = {
  stream() {
    throw new Error("LLM was called on a turn the fast path should handle");
  },
};

function agentCtx(): AgentContext {
  return {
    db,
    restaurant: ctx.restaurant,
    settings: { ...ctx.settings, customerSmsEnabled: true },
    hours: ctx.hours,
    callerNumber: "+61400000001",
    now: () => new Date("2026-09-09T19:00:00+08:00"), // Wednesday, kitchen open
  };
}

async function draftWith(
  agent: OrderAgent,
  items: { name: string; qty: number; mods?: string[][] }[],
  customerName = "",
) {
  const draft = await createDraft(db, {
    restaurantId: ctx.restaurant.id,
    customerName,
    customerPhone: "+61400000001",
  });
  for (const spec of items) {
    const item = await findItemByName(db, spec.name);
    const modIds: string[] = [];
    for (const [itemName, modName] of spec.mods ?? []) {
      modIds.push(await modifierId(db, itemName!, modName!));
    }
    await addOrderItem(db, {
      orderId: draft.id,
      menuItemId: item.id,
      quantity: spec.qty,
      modifierIds: modIds,
    });
  }
  agent.state.draftOrderId = draft.id;
  agent.state.mutationSeq = 3;
  return draft.id;
}

// Proactive phrasing audit — realistic ways real customers talk. A scripted LLM
// stands in for the fallback so a fall-through is a soft miss (fastPath absent),
// not a thrown error. Goal: the common ways to say each thing stay INSTANT.
describe("PROACTIVE phrasing coverage", () => {
  const LLM_FALLBACK: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "[fell to LLM]" };
        yield { type: "stop" as const, reason: "end_turn" as const };
      })();
    },
  };

  const openers = [
    "yeah I'll grab a chicken kebab",
    "can you do us a chicken kebab",
    "I'll take a chicken kebab",
    "chuck us a chicken kebab",
    "throw a chicken kebab in for me",
    "hook us up with a chicken kebab",
    "gimme a chicken kebab",
    "let me get a chicken kebab",
    "just a chicken kebab thanks",
    "chicken kebab for takeaway please",
    "I'll go a chicken kebab",
  ];
  for (const u of openers) {
    it(`opener stays instant: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
    });
  }

  const confirms = [
    "beauty", "too easy", "no worries", "sweet as", "spot on", "that's the one",
    "lock it in", "sounds good", "yep that's it", "all good mate",
  ];
  for (const u of confirms) {
    it(`confirm stays instant: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.mutationSeq = 1;
      agent.state.summarySeq = 1;
      agent.state.lastAssistantText = "That's 12 dollars 95, takeaway for Dave. Confirm?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
    });
  }

  const finishes = [
    "nah that's the lot", "that'll do me", "yeah that's everything",
    "no I'm sweet", "that's me done", "nah I'm right thanks", "all done cheers",
  ];
  for (const u of finishes) {
    it(`finish stays instant: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.lastAssistantText = "Anything else?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
    });
  }

  // QUANTITIES — the item is recognised AND the count is right (no hallucinated qty).
  const quantities: [string, number][] = [
    ["two chicken kebabs", 2],
    ["a couple of chicken kebabs", 2],
    ["couple chicken kebabs", 2],
    ["three chicken kebabs", 3],
    ["just one chicken kebab", 1],
    ["a pair of chicken kebabs", 2],
    ["double chicken kebab", 2],
    ["gimme two chicken kebabs", 2],
  ];
  for (const [u, qty] of quantities) {
    it(`quantity right & instant: "${u}" -> ${qty}`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
      const got =
        agent.state.pendingItem?.quantity ??
        (await getOrderWithItems(db, agent.state.draftOrderId!))!.items[0]?.quantity;
      expect(got, `"${u}" quantity`).toBe(qty);
    });
  }

  // REMOVALS — "leave the onion out". Handled instantly.
  const removals = [
    "no onions", "no onion", "without onions", "hold the onions",
    "leave out the onion", "no onion thanks", "skip the onion", "hold the onion mate",
  ];
  for (const u of removals) {
    it(`removal stays instant: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1, mods: [["Chicken Kebab", "Onion"]] }]);
      agent.state.lastAssistantText = "Anything else?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
    });
  }

  // CHANGES — swap the item to a same-type variant. Handled instantly AND correctly.
  const changes = [
    "make it lamb", "change it to lamb", "swap it for lamb",
    "make it a lamb one", "actually make it lamb", "can you make it lamb",
  ];
  for (const u of changes) {
    it(`change stays instant & correct: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Anything else?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath, `"${u}" fell to the LLM`).toBeTruthy();
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      expect(order!.items.some((i) => i.nameSnapshot === "Lamb Kebab"), `"${u}" -> Lamb Kebab`).toBe(true);
      expect(order!.items.some((i) => i.nameSnapshot === "Chicken Kebab"), `"${u}" left chicken`).toBe(false);
    });
  }

  // ADD-ON: one contextual drink suggestion folded into "Anything else?" — no
  // extra turn, once per call, and only when the order has no drink.
  it("folds a one-shot 'or a drink?' in when the order has food but no drink", async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    const t1 = await agent.handleTurn("beef ribs"); // no required options -> item_added
    expect(t1.fastPath).toBe("item_added");
    expect(t1.text).toBe("Anything else, or a drink?");
    // Once only — the next prompt is plain (a natural variant), never nags a drink.
    const t2 = await agent.handleTurn("beef ribs");
    expect(t2.text).toMatch(/^Anything else/i);
    expect(t2.text).not.toContain("drink");
  });

  it("never suggests a drink when the order already has one", async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    await agent.handleTurn("a can of coke"); // drink first
    const turn = await agent.handleTurn("beef ribs"); // food added, but drink present
    expect(turn.text).toMatch(/^Anything else/i);
    expect(turn.text).not.toContain("drink");
  });

  it("takes the upsell drink even with a leading confirm ('oh yeah go on, a can of coke')", async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    await draftWith(agent, [{ name: "Beef Ribs Plate", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else, or a drink?";
    const turn = await agent.handleTurn("oh yeah go on, a can of coke");
    expect(turn.fastPath, "drink accept fell to the LLM").toBe("drink_added");
  });

  // PROACTIVE "same as last time?" — returning caller answers the greeting offer.
  it("a change/question phrase at the name stage is never captured as a name (MB1123)", async () => {
    const scripted: Llm = {
      stream() {
        return (async function* () {
          yield { type: "text" as const, text: "[fell to LLM]" };
          yield { type: "stop" as const, reason: "end_turn" as const };
        })();
      },
    };
    for (const phrase of ["can you change the falafel for chicken", "make it lamb", "what drinks do you have"]) {
      const agent = new OrderAgent(scripted, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "What name shall I put it under?";
      const turn = await agent.handleTurn(phrase);
      // Must NOT close the order with that phrase as the customer name.
      expect(turn.fastPath, phrase).not.toBe("name_close");
      expect(turn.text.toLowerCase(), phrase).not.toMatch(/for .*\bconfirm\b/);
    }
  });

  it("strips name lead-ins: 'my name is Kevin' / \"I'm Kevin\" -> the bare name (MB1125)", async () => {
    for (const [phrase, expected] of [
      ["my name is Kevin", "Kevin"],
      ["I'm Kevin", "Kevin"],
      ["I am Sam", "Sam"],
      ["call me Dave", "Dave"],
      ["it's for Zoe", "Zoe"],
    ] as const) {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "What name shall I put it under?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBe("name_close");
      expect(turn.text, phrase).toContain(`for ${expected}`);
    }
  });

  it("returning caller declines the repeat -> orders fresh, no LLM", async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    agent.state.repeatOffered = true;
    agent.state.lastAssistantText = "Welcome back to Meat Box! Same as last time?";
    const turn = await agent.handleTurn("no thanks");
    expect(turn.fastPath).toBe("repeat_declined");
    expect(turn.text).toMatch(/what can i get/i);
  });

  it("returning caller ignores the offer and orders directly -> item added, no LLM", async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    agent.state.repeatOffered = true;
    agent.state.lastAssistantText = "Welcome back to Meat Box! Same as last time?";
    const turn = await agent.handleTurn("just a chicken kebab");
    expect(turn.fastPath).toBeTruthy();
    expect(turn.fastPath).not.toBe("repeat_declined");
  });
});

describe("EXHAUSTIVE sauce answers (natural ways to answer 'Sauces?')", () => {
  const sauceCases = [
    "garlic",
    "just garlic",
    "garlic sauce",
    "the garlic one",
    "garlic please",
    "garlic and chilli",
    "garlic and bbq",
    "garlic and barbecue",
    "chilli",
    "bbq",
    "barbecue",
    "barbie",
    "tahini",
    "tahina",
    "garlic and tahini",
    "sweet chilli",
    "garlic and sweet chilli",
    "garlic, chilli and bbq",
  ];
  for (const phrase of sauceCases) {
    it(`sauce answer "${phrase}" fills instantly (no LLM)`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Sauces?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBeTruthy();
      expect(turn.fastPath, phrase).not.toBe("option_reask");
    });
  }
});

// MB1129: the salad turn ("pickles, tabbouleh") fell to the ~2s LLM because
// "tabbouleh" never matched the menu's "Tabouli". Salads must fill instantly.
describe("EXHAUSTIVE salad answers (multi-select, spelling variants)", () => {
  const saladCases = [
    "lettuce",
    "tomato",
    "onion",
    "tabouli",
    "tabbouleh", // spelling variant -> Tabouli
    "pickles",
    "pickle",
    "lettuce and tomato",
    "pickles and tabouli",
    "pickles and tabbouleh",
    "lettuce, tomato and onion",
    "just lettuce",
    "tomato and onion please",
    "lettuce tomato onion tabouli pickles",
  ];
  for (const phrase of saladCases) {
    it(`salad answer "${phrase}" fills instantly (no LLM)`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Which salads — lettuce, tomato, onion, tabouli, pickles?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBeTruthy();
      expect(turn.fastPath, phrase).not.toBe("option_reask");
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      const salads = order!.items[0]!.modifiers
        .filter((m) => m.groupNameSnapshot === "Salads")
        .map((m) => m.nameSnapshot);
      expect(salads.length, phrase).toBeGreaterThan(0);
    });
  }
});

describe("EXHAUSTIVE confirm & finish phrasings", () => {
  const confirms = [
    "yes", "yeah", "yep", "correct", "that's right", "perfect", "confirmed",
    "go ahead", "sounds good", "all good", "lock it in", "that's the one",
    "yes please", "yeah that's right", "good to go", "send it", "spot on",
    "beauty", "no worries", "too easy", "go on then", "that works",
  ];
  for (const phrase of confirms) {
    it(`confirm "${phrase}" -> order placed instantly`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.mutationSeq = 1;
      agent.state.summarySeq = 1;
      agent.state.lastAssistantText = "That's 12 dollars 95, takeaway for Dave. Confirm?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBe("confirm_yes");
    });
  }
  const finishes = [
    "no", "nah", "nope", "that's it", "that's all", "that's the lot",
    "that's a lot", "nah that's a lot",
    "nothing else", "no that's it", "nah that's it", "that'll do", "I'm good",
    "we're good", "that's everything", "all done", "that's me done",
    "nah I'm right", "no I'm sweet", "that'll do me",
  ];
  for (const phrase of finishes) {
    it(`finish "${phrase}" -> moves to name/close instantly`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Anything else?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBeTruthy();
    });
  }
});

describe("EXHAUSTIVE base/option answers (natural ways to answer 'chips and salad, or rice and salad?')", () => {
  const chipsCases = [
    "chips and salad",
    "chips",
    "chips please",
    "chips and salad please",
    "chips and salad thanks",
    "the chips one",
    "chips one",
    "chips and salad mate",
    "yeah chips and salad",
    "uh chips and salad",
    "chips salad",
  ];
  for (const phrase of chipsCases) {
    it(`base answer "${phrase}" fills instantly (no LLM)`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Water", qty: 1 }]);
      const chicken = await findItemByName(db, "Chicken Meatbox");
      agent.state.pendingItem = { menuItemId: chicken.id, quantity: 1, modifierIds: [], removals: [] };
      agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBeTruthy();
      expect(turn.fastPath, phrase).not.toBe("option_reask");
    });
  }
});

describe("overlapped / unintelligible input -> instant 'sorry, say that again?'", () => {
  const scripted = (): Llm => ({
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "[AI]" };
        yield { type: "stop" as const, reason: "end_turn" as const };
      })();
    },
  });

  it("a talked-over (barge) utterance that isn't recognised -> garbled_reask", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.afterBarge = true; // caller talked over Olivia
    const turn = await agent.handleTurn("mumble grumble frazzle bit");
    expect(turn.fastPath).toBe("garbled_reask");
    expect(turn.text.toLowerCase()).toContain("say that again");
  });

  it("the SAME unrecognised words WITHOUT an overlap go to the AI (never a false repeat-ask)", async () => {
    const agent = new OrderAgent(scripted(), agentCtx());
    const turn = await agent.handleTurn("mumble grumble frazzle bit"); // no barge
    expect(turn.fastPath).toBeUndefined();
  });

  it("a real question (even after a barge) is NOT force-repeated if it's clear", async () => {
    // A clear item after a barge is still recognised, not re-asked.
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.afterBarge = true;
    const turn = await agent.handleTurn("a chicken kebab");
    expect(turn.fastPath).not.toBe("garbled_reask");
    expect(turn.fastPath).toBeTruthy();
  });

  it("caps the barge repeat-asks so a stuck caller reaches the AI", async () => {
    const agent = new OrderAgent(scripted(), agentCtx());
    agent.state.afterBarge = true;
    expect((await agent.handleTurn("blarg one")).fastPath).toBe("garbled_reask");
    agent.state.afterBarge = true;
    expect((await agent.handleTurn("wozzle two")).fastPath).toBe("garbled_reask");
    agent.state.afterBarge = true;
    expect((await agent.handleTurn("frooble three")).fastPath).toBeUndefined(); // cap -> AI
  });
});

describe("EXHAUSTIVE name capture (every natural way a caller gives a name)", () => {
  const cases: [string, string][] = [
    ["John", "John"],
    ["it's John", "John"],
    ["it's for John", "John"],
    ["for John", "John"],
    ["the name's John", "John"],
    ["name's John", "John"],
    ["the name is John", "John"],
    ["my name is John", "John"],
    ["my name's John", "John"],
    ["I'm John", "John"],
    ["I am John", "John"],
    ["call me John", "John"],
    ["put it under John", "John"],
    ["under John", "John"],
    ["just John", "John"],
    ["yeah John", "John"],
    ["yeah it's John", "John"],
    ["it's John mate", "John"],
    ["it's John thanks", "John"],
    ["John here", "John"],
    ["put it down for John", "John"],
    ["John Smith", "John Smith"],
    ["it's John Smith", "John Smith"],
  ];
  for (const [phrase, expected] of cases) {
    it(`"${phrase}" -> ${expected}`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "What name shall I put it under?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBe("name_close");
      expect(turn.text, phrase).toContain(`for ${expected}`);
    });
  }
});

describe("COMPOUND orders (multiple items in one breath)", () => {
  it("'two chicken meatboxes and a mixed meatbox' adds both, asking each base in turn, no LLM", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const t1 = await agent.handleTurn("two chicken meatboxes and a mixed meatbox");
    expect(t1.fastPath).toBe("compound_pending");
    expect(t1.text.toLowerCase()).toContain("salad"); // first meatbox's base asked
    const t2 = await agent.handleTurn("chips and salad");
    expect(t2.fastPath).toBe("compound_pending"); // now the mixed meatbox's base
    const t3 = await agent.handleTurn("rice and salad");
    expect(t3.text.toLowerCase()).toMatch(/anything else/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => `${i.quantity}x${i.nameSnapshot}`);
    expect(names).toContain("2xChicken Meatbox");
    expect(names).toContain("1xMixed Meatbox");
  });

  it("'a chicken meatbox and a can of coke' adds the drink automatically after the base, no LLM", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const t1 = await agent.handleTurn("a chicken meatbox and a can of coke");
    expect(t1.fastPath).toBe("compound_pending"); // meatbox base asked, coke queued
    const t2 = await agent.handleTurn("rice and salad");
    // coke has no required option -> added during the drain -> straight to anything else
    expect(t2.text.toLowerCase()).toMatch(/anything else/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => i.nameSnapshot);
    expect(names).toContain("Chicken Meatbox");
    expect(names).toContain("Soft Drink Can");
  });

  it("a compound with an ambiguous/unknown segment falls to the LLM (never a partial guess)", async () => {
    const scripted: Llm = {
      stream() {
        return (async function* () {
          yield { type: "text" as const, text: "[LLM]" };
          yield { type: "stop" as const, reason: "end_turn" as const };
        })();
      },
    };
    const agent = new OrderAgent(scripted, agentCtx());
    // "a kebab" is a family (chicken/lamb/…) — ambiguous inside a compound.
    const turn = await agent.handleTurn("a kebab and a wozzlefrob");
    expect(turn.fastPath).toBeUndefined();
  });
});

describe("classifiers", () => {
  it("recognises Australian yes / finish phrases", () => {
    for (const t of ["Yep", "yeah", "that's right", "correct", "yes please", "all good"]) {
      expect(isYes(t), t).toBe(true);
    }
    for (const t of ["Nah", "no that's it", "that's the lot", "that's me", "nothing else", "nah mate",
      "nah that's the lot", "no that's the lot", "that'll be it"]) {
      expect(isFinished(t), t).toBe(true);
    }
    expect(isYes("no")).toBe(false);
    expect(isFinished("yes")).toBe(false);
    expect(isFinished("actually add a coke")).toBe(false);
  });

  it("accepts confirm-style sentences and rejects negated ones (live call 2026-09-11)", () => {
    for (const t of ["Yeah, we can confirm that", "you can confirm the order", "lock that in please", "I can confirm it"]) {
      expect(isYes(t), t).toBe(true);
    }
    for (const t of ["no, don't confirm that", "actually, change it before you lock it in", "wait, not yet"]) {
      expect(isYes(t), t).toBe(false);
    }
  });

  it("accepts yes-led sentences and rejects change requests (George call 2026-09-11)", () => {
    for (const t of [
      "Yes, that order is correct. Thank you.",
      "Yes. Yes, absolutely. Thank you.",
      "Ye- yes, that, that order is correct",
      "yeah all sounds right",
    ]) {
      expect(isYes(t), t).toBe(true);
    }
    for (const t of [
      "yes but add another coke",
      "yeah actually make it two",
      "yes can you repeat that",
      "sure, cancel it",
      "no, I didn't say yes to this order",
    ]) {
      expect(isYes(t), t).toBe(false);
    }
  });

  it("accepts casual Aussie confirmations (live call misses)", () => {
    for (const t of ["Good to go", "good to go mate", "send it through", "that works", "happy with that", "looks good"]) {
      expect(isYes(t), t).toBe(true);
    }
    // Still distinct from 'finished ordering'
    expect(isFinished("that's it")).toBe(true);
  });

  it("treats 'go on then' as a confirm, not a name (robot call 2026-09-21)", () => {
    // "Yeah, go on then" landed in the name slot and was captured as the
    // customer name "Go On Then"; it is a proceed/confirm, never a name.
    for (const t of ["go on then", "yeah go on then", "go on", "go on mate", "on ya go"]) {
      expect(isYes(t), t).toBe(true);
    }
  });
});

describe("fast paths (LLM must not be called)", () => {
  it('orders a menu item deterministically at the greeting: "two chicken meatboxes" -> base question, no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    // Greeting stage: lastAssistantText empty.
    const res = await agent.handleTurn("two chicken meatboxes");
    expect(res.fastPath).toBe("item_pending");
    // It asked the required base question and stashed the item as pending.
    expect(res.text.toLowerCase()).toMatch(/chips|rice|base/);
    expect(agent.state.draftOrderId).toBeTruthy();
    expect(agent.state.pendingItem?.quantity).toBe(2);
  });

  it('orders fast from a natural phrase: "I want to order a chicken kebab"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("Hi, I want to order a chicken kebab");
    // Kebab has no required options -> adds cleanly, straight to "anything else".
    expect(["item_added", "item_pending"]).toContain(res.fastPath);
    expect(agent.state.draftOrderId).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Chicken Kebab")).toBe(true);
  });

  it("orders the first item fast even when the LLM worded the greeting differently", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    // A varied opener must not disable the deterministic item path.
    agent.state.lastAssistantText = "Hey there! What can I get started for you?";
    const res = await agent.handleTurn("two chicken meatboxes");
    expect(res.fastPath).toBe("item_pending");
    expect(agent.state.draftOrderId).toBeTruthy();
    expect(agent.state.pendingItem?.quantity).toBe(2);
  });

  it('answers a bare greeting instantly ("hey") without the LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("hey there");
    expect(res.fastPath).toBe("greeting_ack");
    expect(res.text).toMatch(/get for you/i);
    expect(agent.state.draftOrderId).toBeFalsy(); // no order created by a greeting
  });

  it('a greeting with an order is NOT treated as a bare greeting', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const res = await agent.handleTurn("hey can I grab two chicken meatboxes");
    // Falls through to the item path, not greeting_ack.
    expect(res.fastPath).not.toBe("greeting_ack");
    expect(agent.state.draftOrderId).toBeTruthy();
  });

  it("adds a no-required-option item deterministically and asks anything else", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const res = await agent.handleTurn("a coke"); // resolved via the drink fast-path
    // Deterministic (no LLM): a soft drink named by flavour adds the can + flavour.
    expect(["item_added", "item_pending", "drink_added"]).toContain(res.fastPath);
    expect(agent.state.draftOrderId).toBeTruthy();
  });

  it('completes a pending item: failed add -> "chips and salad" -> added instantly', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    // Simulate the LLM's add that failed on the missing required Base:
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 1,
      modifierIds: [],
      removals: [],
    };
    agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
    const turn = await agent.handleTurn("chips and salad");
    expect(turn.fastPath).toBe("pending_fill");
    expect(turn.text).toMatch(/^Anything else/i);
    expect(agent.state.pendingItem).toBeNull();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const line = order!.items.find((i) => i.nameSnapshot === "Chicken Meatbox");
    expect(line!.modifiers.map((m) => m.nameSnapshot)).toContain("Chips & Salad");
  });

  it('adds optional sauces with scope: "garlic on both"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
      { name: "Lamb Meatbox", qty: 1, mods: [["Lamb Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("garlic on both");
    expect(turn.fastPath).toBe("optional_fill");
    expect(turn.text).toMatch(/^anything else/i); // may fold in a one-shot "…or a drink?"
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    for (const item of order!.items) {
      expect(item.modifiers.map((m) => m.nameSnapshot)).toContain("Garlic sauce");
    }
  });

  it('finishes: "nah that\'s it" -> total-only close when the name is known (no item recital)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 2, mods: [["Chicken Meatbox", "Chips & Salad"], ["Chicken Meatbox", "Garlic sauce"]] }],
      "Kev",
    );
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("nah that's it");
    expect(turn.fastPath).toBe("close");
    // Owner rule: grand total + name + type, confirm once, NO item read-back.
    expect(turn.text).toMatch(/^That's .+, takeaway for Kev.*Sound good\?$/);
    expect(turn.text.toLowerCase()).toContain("dollars");
    expect(turn.text.toLowerCase()).not.toContain("meatbox");
  });

  it("asks for a name when finishing without one, then reads back after the answer", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Water", qty: 1 },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn1 = await agent.handleTurn("that's all");
    expect(turn1.fastPath).toBe("ask_name");
    expect(turn1.text).toBe("Can I get a name for the order?");
    const turn2 = await agent.handleTurn("it's Kevin");
    expect(turn2.fastPath).toBe("name_close");
    expect(turn2.text).toMatch(/^That's .+, takeaway for Kevin.*Sound good\?$/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Kevin");
  });

  it("captures the name fast even when the LLM re-asked with different wording", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    // The LLM rephrased the name request — the answer must still be fast.
    agent.state.lastAssistantText = "I still need a name for the order.";
    const turn = await agent.handleTurn("Kevin");
    expect(turn.fastPath).toBe("name_close");
    expect(turn.text).toMatch(/^That's .+, takeaway for Kevin.*Sound good\?$/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Kevin");
  });

  it('caller volunteers a name at "anything else?" -> finish + total-only close, no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    // No "no" first — the caller just gives a name with a lead-in.
    const turn = await agent.handleTurn("under Sam");
    expect(turn.fastPath).toBe("name_close");
    expect(turn.text).toMatch(/^That's .+, takeaway for Sam.*Sound good\?$/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Sam");
  });

  it('confirms on the final "yep" after a total-only close ("Confirm?")', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }],
      "Dana",
    );
    agent.state.summarySeq = agent.state.mutationSeq;
    agent.state.lastAssistantText = "That's nineteen ninety, takeaway for Dana. Confirm?";
    const turn = await agent.handleTurn("yep");
    expect(turn.fastPath).toBe("confirm_yes");
    expect(turn.endCall).toBe(true);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.status).toBe("new");
  });

  // NATURALNESS: the warm close ends "Sound good?" instead of a flat "Confirm?".
  // The final "yep" must still confirm instantly off that phrasing.
  it('confirms after the warm close ("... Sound good?")', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }],
      "Dana",
    );
    agent.state.summarySeq = agent.state.mutationSeq;
    agent.state.lastAssistantText = "That's nineteen ninety, takeaway for Dana. Sound good?";
    const turn = await agent.handleTurn("yep");
    expect(turn.fastPath).toBe("confirm_yes");
    expect(turn.endCall).toBe(true);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.status).toBe("new");
  });

  // NATURALNESS: the warm name-ask ("Can I get a name for the order?") must still be
  // recognised as the name stage so the caller's answer is captured fast.
  it("captures the name fast after the warm name-ask phrasing", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Can I get a name for the order?";
    const turn = await agent.handleTurn("Sam");
    expect(turn.fastPath).toBe("name_close");
    expect(turn.text).toMatch(/^That's .+, takeaway for Sam.*Sound good\?$/);
  });

  // MB1129 (live AU call) regressions -------------------------------------------------
  it('name stage: "Kevin. Yes." captures Kevin, not a re-ask (MB1129)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Can I get a name for the order?";
    const turn = await agent.handleTurn("Kevin. Yes.");
    expect(turn.fastPath).toBe("name_close");
    expect(turn.text).toMatch(/for Kevin.*Sound good\?$/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Kevin");
  });

  it('name stage: greeting/test noise is NEVER captured as a name (MB1129)', async () => {
    // Short greeting/test blurts must re-ask instantly, never become the name.
    // (Longer connectivity questions like "can you hear me?" legitimately go to
    // the LLM, which handles them gracefully — not a bug, so not asserted here.)
    for (const junk of [
      "Hello?", "Testing, hello.", "Hello, testing", "Hi there", "Uh-", "Um...", "Er-", "Hmm.",
      "J", "J J", "J. J.",
      // placeholder/connector junk read back as names on live AU calls (MB1135-7)
      "And...", "and", "another", "new order", "Caller", "placeholder",
    ]) {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Can I get a name for the order?";
      const turn = await agent.handleTurn(junk);
      expect(turn.fastPath, junk).toBe("name_reask");
      expect(turn.text.toLowerCase(), junk).not.toMatch(/for (hello|testing)/);
    }
  });

  it("name re-ask is capped — a garbled 'J J J' line falls to the LLM, never loops (MB1134)", async () => {
    const scripted: Llm = {
      stream() {
        return (async function* () {
          yield { type: "text" as const, text: "[llm]" };
          yield { type: "stop" as const, reason: "end_turn" as const };
        })();
      },
    };
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Can I get a name for the order?";
    expect((await agent.handleTurn("J")).fastPath).toBe("name_reask");
    expect((await agent.handleTurn("J")).fastPath).toBe("name_reask");
    const r3 = await agent.handleTurn("J");
    expect(r3.fastPath, "should have fallen to the LLM after the cap").toBeUndefined();
    expect(r3.text).toBe("[llm]");
  });

  it('a "Customer" placeholder name is treated as no name — asks, never reads "for Customer" (MB1129)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Customer");
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("no that's it");
    expect(turn.fastPath).toBe("ask_name");
    expect(turn.text.toLowerCase()).not.toContain("for customer");
  });

  it('first turn "I\'d like to place an order for a chicken kebab" stays on the fast path (MB1129 lag)', async () => {
    // FORBIDDEN_LLM throws if the brain is touched — so this passing PROVES the
    // whole first turn was handled instantly, not by the ~2.4s LLM.
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("I'd like to place an order for a chicken kebab");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.map((i) => i.nameSnapshot)).toContain("Chicken Kebab");
  });

  it('confirms on the final "yep": order stored, closing line, call ends', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }],
      "Dana",
    );
    agent.state.summarySeq = agent.state.mutationSeq;
    agent.state.lastAssistantText = "One Chicken Meatbox with chips and salad. Correct?";
    const turn = await agent.handleTurn("yep");
    expect(turn.fastPath).toBe("confirm_yes");
    expect(turn.endCall).toBe(true);
    expect(turn.text).toMatch(/^Perfect/);
    expect(turn.text).toMatch(/about \d+ minutes/i);
    expect(turn.text).toContain("text");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.status).toBe("new");
    expect(order!.publicOrderNumber).toMatch(/^MB\d+$/);
    expect(agent.state.outcome).toBe("ORDER_COMPLETED");
  });

  it('"hang on" gets a "Yep." and nothing more', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("hang on a sec");
    expect(turn.fastPath).toBe("wait");
    expect(turn.text).toBe("Yep.");
  });
});

describe("curveball phrasing stays fast (varied wording, no LLM)", () => {
  it('"g\'day, can I get a couple of chicken meat boxes" -> item_pending, qty 2', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("Yeah, good day. Can I get a couple of chicken meat boxes?");
    expect(res.fastPath).toBe("item_pending");
    expect(agent.state.pendingItem?.quantity).toBe(2);
  });

  it('casual add-verb "chuck some garlic on both" -> optional_fill (verbs stripped)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
      { name: "Lamb Meatbox", qty: 1, mods: [["Lamb Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Chuck some garlic on both");
    expect(turn.fastPath).toBe("optional_fill");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    for (const item of order!.items) {
      expect(item.modifiers.map((m) => m.nameSnapshot)).toContain("Garlic sauce");
    }
  });

  it('ambiguous "chili" (STT spelling) auto-resolves to the plain Chilli sauce, not Sweet chilli', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
      { name: "Lamb Meatbox", qty: 1, mods: [["Lamb Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Chuck some chili on both");
    expect(turn.fastPath).toBe("optional_fill");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    for (const item of order!.items) {
      const mods = item.modifiers.map((m) => m.nameSnapshot);
      expect(mods).toContain("Chilli sauce");
      expect(mods).not.toContain("Sweet chilli sauce");
    }
  });

  it('"nah, that\'s the lot" -> total-only close (finish recognised)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }],
      "Kev",
    );
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Nah, that's the lot.");
    expect(turn.fastPath).toBe("close");
  });

  it('"yeah, it\'s for Dave" at the name stage -> name captured (not rejected by the yes-guard)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "What name shall I put it under?";
    const turn = await agent.handleTurn("Yeah, it's for Dave.");
    expect(turn.fastPath).toBe("name_close");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Dave");
  });

  it('deterministic swap: "make one of them a lamb one" -> 1 chicken + 1 lamb, options carried', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      {
        name: "Chicken Meatbox",
        qty: 2,
        mods: [["Chicken Meatbox", "Rice & Salad"], ["Chicken Meatbox", "Chilli sauce"]],
      },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Actually, make one of them a lamb one.");
    expect(turn.fastPath).toBe("item_swap");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const chicken = order!.items.find((i) => i.nameSnapshot === "Chicken Meatbox");
    const lamb = order!.items.find((i) => i.nameSnapshot === "Lamb Meatbox");
    expect(chicken?.quantity).toBe(1);
    expect(lamb?.quantity).toBe(1);
    // The lamb carried the same options across.
    expect(lamb!.modifiers.map((m) => m.nameSnapshot).sort()).toEqual(["Chilli sauce", "Rice & Salad"]);
  });

  it('drink by flavour at greeting: "a coke" -> Soft Drink Can + Coke, fast', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const turn = await agent.handleTurn("Yeah, can I grab a coke?");
    expect(turn.fastPath).toBe("drink_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const can = order!.items.find((i) => i.nameSnapshot === "Soft Drink Can");
    expect(can).toBeTruthy();
    expect(can!.modifiers.map((m) => m.nameSnapshot)).toContain("Coke");
  });

  it('drink flavour is unambiguous: "a coke" -> Coke, not Coke No Sugar', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Anything else?";
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    const turn = await agent.handleTurn("and a can of fanta");
    expect(turn.fastPath).toBe("drink_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const can = order!.items.find((i) => i.nameSnapshot === "Soft Drink Can");
    expect(can!.modifiers.map((m) => m.nameSnapshot)).toContain("Fanta");
  });

  it('option change: "make it a fanta" changes the drink flavour, deterministic', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Soft Drink Can", qty: 1, mods: [["Soft Drink Can", "Coke"]] }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Actually, make it a Fanta instead.");
    expect(turn.fastPath).toBe("option_change");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const can = order!.items.find((i) => i.nameSnapshot === "Soft Drink Can");
    const mods = can!.modifiers.map((m) => m.nameSnapshot);
    expect(mods).toContain("Fanta");
    expect(mods).not.toContain("Coke");
  });

  it('option change: "change it to rice" swaps the base, keeps other options', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"], ["Chicken Meatbox", "Garlic sauce"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Change it to rice");
    expect(turn.fastPath).toBe("option_change");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const box = order!.items.find((i) => i.nameSnapshot === "Chicken Meatbox");
    const mods = box!.modifiers.map((m) => m.nameSnapshot);
    expect(mods).toContain("Rice & Salad");
    expect(mods).not.toContain("Chips & Salad");
    expect(mods).toContain("Garlic sauce"); // other options preserved
  });

  it('item names with filler words fast-path: "a meatbox burger with the lot"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("Can I grab a meatbox burger with the lot?");
    expect(["item_added", "item_pending"]).toContain(res.fastPath);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Meatbox Burger with the Lot")).toBe(true);
  });

  it('deterministic swap on a single item: "change it to a lamb meatbox" -> replaces it', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("Change one to a lamb meatbox");
    expect(turn.fastPath).toBe("item_swap");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Chicken Meatbox")).toBe(false);
    expect(order!.items.some((i) => i.nameSnapshot === "Lamb Meatbox")).toBe(true);
  });
});

describe("tryFastPathOnly (partial probe)", () => {
  it("returns a result for a clean deterministic turn (no LLM)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const res = await agent.tryFastPathOnly("garlic on both");
    expect(res).not.toBeNull();
    expect(res!.fastPath).toBe("optional_fill");
    expect(res!.text).toMatch(/^anything else/i); // may fold in a one-shot "…or a drink?"
  });

  it("returns null when the turn needs the LLM (no side effects, no speech)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    // A truncated/ambiguous partial must NOT be guessed — probe returns null
    // so the caller waits for the accurate committed transcript.
    const res = await agent.tryFastPathOnly("what's in the meat");
    expect(res).toBeNull();
  });

  it("in probe mode, a new item add is refused (could be a prefix of a bigger order)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    // Greeting stage, would normally add via matchMenuItem — but a PARTIAL
    // could be "two chicken meatboxes" cut from "...and a coke", so a probe
    // must not add; it waits for the committed transcript.
    const probe = await agent.tryFastPathOnly("two chicken meatboxes", {}, { probe: true });
    expect(probe).toBeNull();
    expect(agent.state.draftOrderId).toBeFalsy(); // nothing was created
    // The SAME text on the committed path (no probe flag) DOES add it.
    const full = await agent.tryFastPathOnly("two chicken meatboxes");
    expect(full).not.toBeNull();
    expect(full!.fastPath).toBe("item_pending");
  });
});

describe("pending-item safety", () => {
  it("an unrelated successful add must NOT clear the pending item", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 2,
      modifierIds: [],
      removals: [],
    };
    // Simulate the executor's successful add of a DIFFERENT item (kebab):
    const { executeTool } = await import("../src/agent/tools");
    const kebab = await findItemByName(db, "Chicken Kebab");
    const result = await executeTool(
      { ...agentCtx() },
      agent.state,
      "add_order_item",
      { menuItemId: kebab.id, quantity: 1 },
    );
    expect(result.error).toBeUndefined();
    expect(agent.state.pendingItem).not.toBeNull(); // meatboxes still pending
    // …and the pending fast path still completes them:
    agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
    const turn = await agent.handleTurn("chips and salad on both");
    expect(turn.fastPath).toBe("pending_fill");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Chicken Meatbox" && i.quantity === 2)).toBe(
      true,
    );
  });

  it("set_order_details ignores an order-type word as the customer name (MB1117)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    const { executeTool } = await import("../src/agent/tools");
    // The LLM lifted "takeaway" from "order for a takeaway" -> must NOT become the name.
    await executeTool({ ...agentCtx() }, agent.state, "set_order_details", { customerName: "Takeaway" });
    const o1 = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(o1!.customerName.toLowerCase()).not.toBe("takeaway");
    // A real name still sets normally.
    await executeTool({ ...agentCtx() }, agent.state, "set_order_details", { customerName: "Kevin" });
    const o2 = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(o2!.customerName).toBe("Kevin");
  });

  it('finishing with an unresolved pending item falls through to the LLM (never drop an item)', async () => {
    const scripted: Llm = {
      stream() {
        return (async function* () {
          yield { type: "text" as const, text: "LLM resolves it." };
          yield { type: "stop" as const, reason: "end_turn" };
        })();
      },
    };
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }], "Kev");
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 1,
      modifierIds: [],
      removals: [],
    };
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("nah that's it");
    expect(turn.fastPath).toBeUndefined();
    expect(turn.text).toBe("LLM resolves it.");
  });
});

describe("fall-through to the LLM", () => {
  const scripted: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "Falling back." };
        yield { type: "stop" as const, reason: "end_turn" };
      })();
    },
  };

  it("ambiguous option word is re-asked instantly, never guessed", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 1,
      modifierIds: [],
      removals: [],
    };
    agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
    // "salad" alone matches both bases -> must NOT be guessed; re-ask instantly
    // (no ~2s LLM turn) instead of falling through.
    const turn = await agent.handleTurn("salad");
    expect(turn.fastPath).toBe("option_reask");
    expect(turn.text.toLowerCase()).toContain("chips and salad");
    expect(turn.text.toLowerCase()).toContain("rice and salad");
  });

  it("garbled base answers re-ask instantly, then fall to the LLM after two (India call 2026-09-21)", async () => {
    const agent = new OrderAgent(scripted, agentCtx()); // scripted LLM -> "Falling back."
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 1,
      modifierIds: [],
      removals: [],
    };
    agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
    // A poor line mangles "chips and salad" -> re-ask instantly, not a ~2s LLM turn.
    const t1 = await agent.handleTurn("a chicken salad");
    expect(t1.fastPath).toBe("option_reask");
    const t2 = await agent.handleTurn("chicken salad");
    expect(t2.fastPath).toBe("option_reask");
    // Third unclear answer: cap reached, hand to the LLM so it can help.
    const t3 = await agent.handleTurn("balayjeen salam");
    expect(t3.fastPath).toBeUndefined();
  });

  it("a real intent during a base question still reaches the LLM (never trapped in re-ask)", async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    const chicken = await findItemByName(db, "Chicken Meatbox");
    agent.state.pendingItem = {
      menuItemId: chicken.id,
      quantity: 1,
      modifierIds: [],
      removals: [],
    };
    agent.state.lastAssistantText = "Chips and salad, or rice and salad?";
    // "and a coke" is a new item, not a garbled base -> must not be re-asked.
    const turn = await agent.handleTurn("and a coke");
    expect(turn.fastPath).not.toBe("option_reask");
  });

  it("adds a clear item instantly even after the AI's own clarify question, no order yet (India call 2026-09-21)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    // No order started; the LLM just asked a family clarify. A clean item name
    // here must add instantly (it took a ~1.8s LLM turn before this fix).
    agent.state.lastAssistantText = "Chicken or lamb?";
    const turn = await agent.handleTurn("chicken meatbox");
    // Chicken Meatbox needs a base -> saved pending + base asked, but all fast (no LLM).
    expect(turn.fastPath).toBe("item_pending");
    expect(turn.text.toLowerCase()).toContain("salad");
  });

  it("strips a hesitation opener and still adds the item instantly ('Mm, two chicken meatbox')", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    // "Mm," used to survive into the tokens and break the set-equality match,
    // sending a clean order to a ~2s LLM turn.
    const turn = await agent.handleTurn("Mm, two chicken meatbox");
    expect(turn.fastPath).toBe("item_pending");
    expect(turn.text.toLowerCase()).toContain("salad");
  });

  it("never fast-closes an EMPTY order at the name stage — no '0 dollars' (MB1113)", async () => {
    const agent = new OrderAgent(scripted, agentCtx()); // scripted LLM -> "Falling back."
    await draftWith(agent, []); // draft exists, but NO items were ever added
    agent.state.lastAssistantText = "What name shall I put it under?";
    const turn = await agent.handleTurn("Kevin");
    // Must NOT fast-close a $0 empty order; hand to the LLM instead.
    expect(turn.fastPath).not.toBe("name_close");
    expect(turn.text).not.toContain("0 dollars");
  });

  it("free speech falls through", async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("what's in the meatbox actually");
    expect(turn.fastPath).toBeUndefined();
  });

  it('a finish phrase at the name stage is re-asked instantly, not taken as the name', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }]);
    agent.state.lastAssistantText = "What name shall I put it under?";
    // STT split an earlier "no, that's it" onto the name turn — must not become a
    // name, and now re-asks deterministically (no LLM) instead of stalling.
    const turn = await agent.handleTurn("No, that's it. Thanks.");
    expect(turn.fastPath).toBe("name_reask");
    expect(turn.text.toLowerCase()).toContain("name");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("");
  });

  it('a bare unknown word at "anything else?" is NOT guessed as a name', async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] }]);
    agent.state.lastAssistantText = "Anything else?";
    // Could be a garbled item — no explicit name lead-in, so let the LLM handle it.
    const turn = await agent.handleTurn("brint");
    expect(turn.fastPath).toBeUndefined();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("");
  });

  it('"no" at the read-back (a correction) falls through', async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }], "Kev");
    agent.state.summarySeq = agent.state.mutationSeq;
    agent.state.lastAssistantText = "One water. Correct?";
    const turn = await agent.handleTurn("no, make it two");
    expect(turn.fastPath).toBeUndefined();
  });
});

describe("terse read-back builder", () => {
  it("compresses a shared modifier across two lines", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"], ["Chicken Meatbox", "Garlic sauce"]] },
      { name: "Lamb Meatbox", qty: 1, mods: [["Lamb Meatbox", "Chips & Salad"], ["Lamb Meatbox", "Garlic sauce"]] },
    ]);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const text = terseReadback(order!);
    expect(text).toMatch(/on both\. Correct\?$/);
  });

  it("keeps distinct modifiers per line and speaks removals", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const draftId = await draftWith(agent, [
      { name: "Chicken Kebab", qty: 1, mods: [["Chicken Kebab", "Garlic sauce"]] },
    ]);
    await db.query(`UPDATE order_items SET removals = '{onion}' WHERE order_id = $1`, [draftId]);
    const order = await getOrderWithItems(db, draftId);
    const text = terseReadback(order!);
    expect(text.toLowerCase()).toContain("one chicken kebab with garlic");
    expect(text.toLowerCase()).toContain("no onion");
  });
});

// Regressions from Kevin's live AU-number test call (2026-09-18): a real
// caller ordered conversationally — an intent opener, a reordered item name,
// "what salads do you have?", "all of them" — and every one of those turns
// fell through to the slow LLM ("One sec" fillers). They must all fast-path.
describe("natural-speech fast paths (Kevin 2026-09-18)", () => {
  it('answers a bare order-intent opener instantly: "I\'d like to place an order for a takeaway"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("Hi, I'd like to place an order for a takeaway");
    expect(res.fastPath).toBe("intent_ack");
    expect(res.text.toLowerCase()).toContain("what can i get");
    expect(agent.state.draftOrderId).toBeFalsy(); // no item yet — just handed off
  });

  it('matches an item whatever the word order / order-type wrapper: "a takeaway kebab, chicken"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const res = await agent.handleTurn("a takeaway kebab, sandwich, chicken");
    expect(["item_added", "item_pending"]).toContain(res.fastPath);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Chicken Kebab")).toBe(true);
  });

  it('lists a group\'s options when asked "what salads do you have?" — no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Which salads do you want on it?";
    const res = await agent.handleTurn("uh, what salads do you have?");
    expect(res.fastPath).toBe("options_listed");
    const t = res.text.toLowerCase();
    for (const s of ["lettuce", "tomato", "onion", "tabouli", "pickles"]) expect(t).toContain(s);
  });

  it('"all of them" fills every option of a group that allows it (salads)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const draftId = await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Which salads do you want on it?";
    const res = await agent.handleTurn("all of the above");
    expect(res.fastPath).toBe("select_all");
    const order = await getOrderWithItems(db, draftId);
    const salads = order!.items[0]!.modifiers
      .filter((m) => m.groupNameSnapshot === "Salads")
      .map((m) => m.nameSnapshot)
      .sort();
    expect(salads).toEqual(["Lettuce", "Onion", "Pickles", "Tabouli", "Tomato"]);
  });

  it('"all of them" on a capped group (6 sauces, pick 3) lists them and asks which', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Any sauce? Garlic, chilli, BBQ, tomato, sweet chilli, or tahini?";
    const res = await agent.handleTurn("all of them");
    expect(res.fastPath).toBe("over_max");
    expect(res.text.toLowerCase()).toContain("pick up to three");
    expect(res.text.toLowerCase()).toContain("garlic");
  });

  it('"a kebab" -> asks which kind -> "falafel" adds Falafel Kebab (no LLM)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Hi, Welcome to Meat Box, what can I get you?";
    const clarify = await agent.handleTurn("uh, can I get a kebab");
    expect(clarify.fastPath).toBe("item_clarify");
    expect(clarify.text.toLowerCase()).toContain("falafel");
    expect(agent.state.pendingFamily).toBeTruthy();
    const res = await agent.handleTurn("falafel");
    expect(["item_added", "item_pending"]).toContain(res.fastPath);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Falafel Kebab")).toBe(true);
    expect(agent.state.pendingFamily).toBeFalsy();
  });

  it('adds a drink right after a "say that again?" re-ask (no LLM, not dropped)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Sorry, say that again?";
    const res = await agent.handleTurn("a can of coke");
    expect(res.fastPath).toBe("drink_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Soft Drink Can")).toBe(true);
  });

  it('recognises spoken synonyms: "barbecue" -> BBQ sauce (no LLM)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Any sauce? Garlic, chilli, bbq, tomato, sweet chilli, or tahini?";
    const res = await agent.handleTurn("uh, barbecue");
    expect(["optional_fill", "option_fill"]).toContain(res.fastPath);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items[0]!.modifiers.map((m) => m.nameSnapshot)).toContain("BBQ sauce");
  });

  it('never closes as "Unknown" — asks for the name instead', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Unknown");
    agent.state.lastAssistantText = "Anything else?";
    const res = await agent.handleTurn("no, that's the lot");
    expect(res.fastPath).toBe("ask_name");
    expect(res.text.toLowerCase()).toContain("name");
  });
});

// Curveballs that happen WHILE taking an order must be handled cleanly on the
// fast path — no error, no dropped/duplicated item, no hallucination (MB1135).
describe("CURVEBALLS mid-order stay clean and fast", () => {
  it('remove a line: "actually, cancel the coke" drops just the Coke', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Kebab", qty: 1 },
      { name: "Soft Drink Can", qty: 1, mods: [["Soft Drink Can", "Coke"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("actually, cancel the coke");
    expect(turn.fastPath, "remove should be deterministic").toBeTruthy();
    // Dealt with casually — a quick ack, then straight on (detection intact).
    expect(turn.text.toLowerCase()).toContain("no worries");
    expect(turn.text.toLowerCase()).toMatch(/anything else/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => i.nameSnapshot);
    expect(names).toContain("Chicken Kebab");
    expect(names).not.toContain("Soft Drink Can");
  });

  it('quantity change: "make it two" doubles the sole line, no new line', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("actually make it two");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items).toHaveLength(1);
    expect(order!.items[0]!.quantity).toBe(2);
  });

  it('base swap mid-order: "change it to rice" keeps the item, swaps the base', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Chicken Meatbox", qty: 1, mods: [["Chicken Meatbox", "Chips & Salad"]] },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("change it to rice");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const mods = order!.items[0]!.modifiers.map((m) => m.nameSnapshot);
    expect(mods).toContain("Rice & Salad");
    expect(mods).not.toContain("Chips & Salad");
  });

  it('add a drink mid-order: "oh and a can of coke" adds it, no duplicate item', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("oh and a can of coke");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => i.nameSnapshot);
    expect(names.filter((n) => n === "Chicken Kebab")).toHaveLength(1);
    expect(names.some((n) => /drink|coke/i.test(n))).toBe(true);
  });

  it('select-all salads: "the lot" / "everything" fills every salad', async () => {
    for (const phrase of ["the lot", "everything", "all of them"]) {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Which salads — lettuce, tomato, onion, tabouli, pickles?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBeTruthy();
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      const salads = order!.items[0]!.modifiers.filter((m) => m.groupNameSnapshot === "Salads");
      expect(salads.length, `${phrase} should select every salad`).toBe(5);
    }
  });
});

// Returning caller declines "same as last time?" — a fresh-order decline must
// hand off instantly, but a decline that names an item must NOT be swallowed
// (live AU calls MB1135-7 took a ~2s LLM turn on the decline).
describe("repeat-offer decline hands off fast (no LLM), never swallows an item", () => {
  const scripted: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "[llm]" };
        yield { type: "stop" as const, reason: "end_turn" as const };
      })();
    },
  };
  for (const phrase of [
    "no",
    "no, I'd like to make a new order",
    "nah, another order please",
    "no I wanna place a new order",
    "start again",
  ]) {
    it(`fresh-order decline "${phrase}" -> instant hand-off`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      agent.state.repeatOffered = true;
      agent.state.lastAssistantText = "Welcome back to Meat Box! Same as last time?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBe("repeat_declined");
      expect(turn.text.toLowerCase()).toContain("what can i get you");
    });
  }
  it('decline that names an item ("no, a chicken kebab") is NOT swallowed', async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    agent.state.repeatOffered = true;
    agent.state.lastAssistantText = "Welcome back to Meat Box! Same as last time?";
    const turn = await agent.handleTurn("no, a chicken kebab");
    // Either fast-added or handed to the LLM — but NOT treated as a bare decline.
    expect(turn.fastPath).not.toBe("repeat_declined");
  });
});

// The AU-call first-turn phrasings must fast-path (the ~2s was the repeat
// decline, since fixed — the items themselves must not touch the LLM).
describe("AU first-turn item phrasings stay instant", () => {
  it('"I wanna order a takeaway chicken kebab sandwich" -> Chicken Kebab, no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("I wanna order a takeaway chicken kebab sandwich");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.map((i) => i.nameSnapshot)).toContain("Chicken Kebab");
  });
  it('"I\'ll order a fish and chips" -> Fish & Chips, no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("I'll order a fish and chips");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => /fish & chips/i.test(i.nameSnapshot))).toBe(true);
  });
});

// Phrasing coverage — first-turn wordings that used to fall to the ~2s LLM must
// fast-path (probe 2026-09-24: parentheticals, format words, inline size).
describe("first-turn phrasing tightening", () => {
  it('"I\'ll grab a falafel" -> Falafel (4 pieces), no LLM', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("I'll grab a falafel");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => /falafel \(4 pieces\)/i.test(i.nameSnapshot))).toBe(true);
  });

  it('"can I get a chicken kebab wrap" -> Chicken Kebab (redundant "wrap" dropped)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("can I get a chicken kebab wrap");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.map((i) => i.nameSnapshot)).toContain("Chicken Kebab");
  });

  it('"some chips" / "a serve of chips" -> Chips fast (asks the required size, no LLM)', async () => {
    for (const phrase of ["some chips", "a serve of chips"]) {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      const turn = await agent.handleTurn(phrase);
      // Chips has a required Size -> held as pending with the size question. The
      // point is it's handled instantly, not by the LLM (FORBIDDEN_LLM proves it).
      expect(turn.fastPath, phrase).toBeTruthy();
      expect(turn.text.toLowerCase(), phrase).toMatch(/small|large|size/);
    }
  });

  it('inline size "large chips" -> Chips with Large applied in ONE turn', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("large chips");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const chips = order!.items.find((i) => i.nameSnapshot === "Chips");
    expect(chips, "Chips added").toBeTruthy();
    expect(chips!.modifiers.map((m) => m.nameSnapshot)).toContain("Large");
  });

  it('inline size on an item without one: "large chicken meatbox" -> handled fast (no error, asks base)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("large chicken meatbox");
    // "large" isn't an option on a meatbox -> dropped, item added, base asked.
    // The point is it fast-paths (no LLM) instead of erroring on the bad option.
    expect(turn.fastPath).toBeTruthy();
    expect(turn.text.toLowerCase()).toMatch(/chips|rice|salad|base/);
  });
});

// Spell-confirm: the name is read back letter-by-letter in the close so a
// mis-heard name is caught before the order is placed (Kevin 2026-09-24).
describe("spell-confirm only for garbled-looking names (Kevin: not every call)", () => {
  it("spells a garbled-looking name back (no vowel / too short)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Ng");
    agent.state.lastAssistantText = "Anything else?";
    const close = await agent.handleTurn("that's it");
    expect(close.text).toMatch(/for Ng, that's N\. G\. Sound good\?$/);
    const yes = await agent.handleTurn("yep");
    expect(yes.fastPath).toBe("confirm_yes");
  });
  it("does NOT spell a normal name — common OR uncommon — stays fast", async () => {
    for (const nm of ["Jovan", "Sam", "Kevin"]) {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], nm);
      agent.state.lastAssistantText = "Anything else?";
      const close = await agent.handleTurn("that's it");
      expect(close.text, nm).toMatch(new RegExp(`for ${nm}\\. Sound good\\?$`));
      expect(close.text, nm).not.toMatch(/that's [A-Z]\./);
    }
  });
  it("name capture at the name stage still works (normal name, no spelling)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Can I get a name for the order?";
    const turn = await agent.handleTurn("it's Jovan");
    expect(turn.fastPath).toBe("name_close");
    expect(turn.text).toMatch(/for Jovan\. Sound good\?$/);
  });
});

// WHOLE-MENU item coverage — every item, realistic phrasing, must fast-path to
// the CORRECT item (added, or held pending if it needs a required option). No
// LLM (FORBIDDEN_LLM throws if the brain is touched). Guards against regressions
// in matchMenuItem / aliases / parentheticals across the entire menu (2026-09-24).
describe("WHOLE-MENU item phrasing coverage (no LLM, correct item)", () => {
  const cases: [string, string][] = [
    ["a chicken meatbox", "Chicken Meatbox"], ["lamb meat box", "Lamb Meatbox"], ["a mixed box", "Mixed Meatbox"],
    ["a chicken kebab", "Chicken Kebab"], ["a lamb kebab", "Lamb Kebab"], ["mixed kebab", "Mixed Kebab"], ["falafel kebab", "Falafel Kebab"],
    ["shish taouk", "Shish Taouk with Chips & Salad"], ["shish tawook", "Shish Taouk with Chips & Salad"], ["chicken skewers", "Shish Taouk with Chips & Salad"],
    ["kafta", "Kafta with Chips & Salad"], ["kofta", "Kafta with Chips & Salad"],
    ["lamb shank", "Lamb Shank with Rice & Salad"], ["beef ribs", "Beef Ribs Plate"], ["ribs", "Beef Ribs Plate"],
    ["lahme skewer", "Lahme Skewer"], ["lamb skewer", "Lahme Skewer"],
    ["a chicken burger", "Chicken Burger"], ["a lamb burger", "Lamb Burger"], ["burger with the lot", "Meatbox Burger with the Lot"],
    ["zaatar manakish", "Zaatar Manakish"], ["zaatar", "Zaatar Manakish"], ["lamb pide", "Lamb Pide"], ["chicken pizza", "Chicken Pizza"], ["lamb gozleme", "Lamb Gozleme"],
    ["fish and chips", "Fish & Chips (3 pieces NZ Cod)"], ["fish n chips", "Fish & Chips (3 pieces NZ Cod)"],
    ["quarter chicken", "Quarter Chicken & Chips"], ["half chicken meal", "Half Charcoal Chicken Meal"], ["whole chicken", "Whole Charcoal Chicken"], ["full chicken", "Whole Charcoal Chicken"],
    ["garlic bread", "Garlic Bread"], ["some rice", "Rice"], ["tabouli", "Tabouli"], ["tabbouleh", "Tabouli"], ["falafel", "Falafel (4 pieces)"],
    ["garlic dip", "Garlic Dip"], ["toum", "Garlic Dip"], ["hummus", "Hummus"], ["hommus", "Hummus"], ["chilli dip", "Chilli Dip"], ["tahini dip", "Tahini Dip"],
    ["a water", "Water"], ["an ayran", "Ayran"], ["milk tea", "Classic Milk Tea"], ["taro milk tea", "Taro Milk Tea"], ["mango fruit tea", "Mango Fruit Tea"],
  ];
  for (const [say, expected] of cases) {
    it(`"${say}" -> ${expected}`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await agent.handleTurn(say);
      const item = await findItemByName(db, expected);
      let hit = agent.state.pendingItem?.menuItemId === item.id;
      if (!hit && agent.state.draftOrderId) {
        const order = await getOrderWithItems(db, agent.state.draftOrderId);
        hit = !!order?.items.some((i) => i.menuItemId === item.id);
      }
      expect(hit, `"${say}" did not yield ${expected}`).toBe(true);
    });
  }
});

describe("ambiguous openers clarify, never silently pick a wrong item", () => {
  const scripted: Llm = { stream() { return (async function* () { yield { type: "text" as const, text: "[clarify]" }; yield { type: "stop" as const, reason: "end_turn" as const }; })(); } };
  for (const say of ["chicken", "lamb", "meatbox", "a kebab", "a burger", "a skewer", "a gozleme"]) {
    it(`"${say}" adds nothing until clarified`, async () => {
      const agent = new OrderAgent(scripted, agentCtx());
      await agent.handleTurn(say);
      const order = agent.state.draftOrderId ? await getOrderWithItems(db, agent.state.draftOrderId) : null;
      const added = (order?.items.length ?? 0) + (agent.state.pendingItem ? 1 : 0);
      expect(added, `"${say}" silently added ${order?.items.map((i) => i.nameSnapshot).join(",")}`).toBe(0);
    });
  }
});

describe("quantities are captured", () => {
  const qty: [string, number][] = [
    ["two chicken kebabs", 2], ["a couple of lamb kebabs", 2], ["three chicken meatboxes", 3],
    ["a dozen falafel", 12], ["five garlic breads", 5],
  ];
  for (const [say, n] of qty) {
    it(`"${say}" -> qty ${n}`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await agent.handleTurn(say);
      const order = agent.state.draftOrderId ? await getOrderWithItems(db, agent.state.draftOrderId) : null;
      const q = order?.items[0]?.quantity ?? agent.state.pendingItem?.quantity ?? 0;
      expect(q, `"${say}"`).toBe(n);
    });
  }
});

// Wrap / roll / sandwich = a KEBAB at this shop. Every meat's wrap/roll/sandwich
// must resolve to that meat's kebab (NOT the falafel side, NOT the LLM) — the
// aliases only covered chicken/lamb wrap before (2026-09-24).
describe("wrap / roll / sandwich resolve to the kebab", () => {
  const cases: [string, string][] = [
    ["chicken wrap", "Chicken Kebab"], ["lamb wrap", "Lamb Kebab"], ["mixed wrap", "Mixed Kebab"], ["falafel wrap", "Falafel Kebab"],
    ["chicken roll", "Chicken Kebab"], ["lamb roll", "Lamb Kebab"], ["mixed roll", "Mixed Kebab"], ["falafel roll", "Falafel Kebab"],
    ["chicken sandwich", "Chicken Kebab"], ["lamb sandwich", "Lamb Kebab"], ["falafel sandwich", "Falafel Kebab"],
    ["chicken kebab wrap", "Chicken Kebab"], ["lamb kebab roll", "Lamb Kebab"],
    ["a chicken wrap please", "Chicken Kebab"], ["two lamb wraps", "Lamb Kebab"],
  ];
  for (const [say, expected] of cases) {
    it(`"${say}" -> ${expected}`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await agent.handleTurn(say);
      const item = await findItemByName(db, expected);
      let hit = agent.state.pendingItem?.menuItemId === item.id;
      if (!hit && agent.state.draftOrderId) {
        const order = await getOrderWithItems(db, agent.state.draftOrderId);
        hit = !!order?.items.some((i) => i.menuItemId === item.id);
      }
      expect(hit, `"${say}" did not yield ${expected}`).toBe(true);
    });
  }
});

// A menu request must instantly read the menu back, not deflect with "what can
// I get you?" or drop to the LLM (live AU NO_ORDER call: "tell me the menu").
describe("menu request reads the menu instantly", () => {
  for (const phrase of ["what's the menu", "menu please", "what do you have", "what have you got", "what are the options", "no, tell me the menu"]) {
    it(`"${phrase}" -> menu, no LLM`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      agent.state.repeatOffered = true; // returning caller who declines + asks menu
      agent.state.lastAssistantText = "Welcome back to Meat Box! Same as last time?";
      const turn = await agent.handleTurn(phrase);
      expect(turn.fastPath, phrase).toBe("menu");
      expect(turn.text.toLowerCase(), phrase).toMatch(/meatbox|kebab/);
      expect(turn.text.toLowerCase(), phrase).toMatch(/what are you after|what can i get/);
    });
  }
  it("a normal order is NOT treated as a menu request", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("can I get a chicken kebab");
    expect(turn.fastPath).not.toBe("menu");
  });
});

// The brain asked "chicken, lamb, or mixed meatbox?" and the caller answers a
// bare meat — it must land as that item, not re-clarify and loop (live AU
// NO_ORDER call, turns 6-7).
describe("meat answer to a 'which <family>?' clarify resolves to the item", () => {
  for (const [meat, expected, ll] of [
    ["chicken", "Chicken Meatbox", "Chicken, lamb, or mixed meatbox?"],
    ["lamb", "Lamb Meatbox", "Which meatbox — chicken, lamb, or mixed?"],
    ["mixed", "Mixed Meatbox", "Chicken, lamb, or mixed meatbox?"],
    ["lamb", "Lamb Kebab", "Chicken, lamb, or mixed kebab?"],
  ] as const) {
    it(`"${meat}" after "${ll}" -> ${expected}`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      agent.state.lastAssistantText = ll;
      const turn = await agent.handleTurn(meat);
      expect(turn.fastPath, meat).toBeTruthy();
      expect(turn.fastPath, meat).not.toBe("item_clarify");
      const item = await findItemByName(db, expected);
      let hit = agent.state.pendingItem?.menuItemId === item.id;
      if (!hit && agent.state.draftOrderId) {
        const o = await getOrderWithItems(db, agent.state.draftOrderId);
        hit = !!o?.items.some((i) => i.menuItemId === item.id);
      }
      expect(hit, `${meat} -> ${expected}`).toBe(true);
    });
  }
  it('a fuller answer "chicken kebab" after a meatbox clarify routes to Chicken Kebab', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    agent.state.lastAssistantText = "Chicken, lamb, or mixed meatbox?";
    await agent.handleTurn("chicken kebab");
    const kebab = await findItemByName(db, "Chicken Kebab");
    const o = agent.state.draftOrderId ? await getOrderWithItems(db, agent.state.draftOrderId) : null;
    const hit = agent.state.pendingItem?.menuItemId === kebab.id || !!o?.items.some((i) => i.menuItemId === kebab.id);
    expect(hit).toBe(true);
  });
});

// More natural confirm/finish phrasings customers actually use (view-probe
// 2026-09-24) — the assistant must handle the many ways to say yes / "I'm done".
describe("broad confirm phrasings", () => {
  for (const p of ["book it", "book it in", "bang on", "you got it", "please do", "lock her in", "that'll be right", "that is right", "nailed it", "do it"]) {
    it(`confirm "${p}"`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.mutationSeq = 1; agent.state.summarySeq = 1;
      agent.state.lastAssistantText = "That's 12 dollars 95, takeaway for Dave. Sound good?";
      expect((await agent.handleTurn(p)).fastPath, p).toBe("confirm_yes");
    });
  }
});
describe("broad finish phrasings", () => {
  for (const p of ["that's it for now", "that's enough", "leave it there", "finished", "all set", "that's plenty", "that'll be it", "no more thanks", "that is it"]) {
    it(`finish "${p}"`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.lastAssistantText = "Anything else?";
      const t = await agent.handleTurn(p);
      expect(t.fastPath, p).toBeTruthy();
    });
  }
});

// MB1140 (live AU call 2026-09-24): the caller added a SECOND item after the
// LLM answered a curveball with a free-form "Want another one?" prompt — a
// phrasing atOpenPromptStage didn't recognise, so the add fell to the LLM,
// which acknowledged it in words ("Yep, sauce?") but NEVER called
// add_order_item. The falafel was silently dropped and the total-only close
// hid it. Fix: recognise item-invite prompts + strip additive words ("also",
// "too", "another") so a clean second item ALWAYS adds deterministically.
describe("mid-order second item after a free-form invite (MB1140 drop)", () => {
  // The exact stage that broke: the LLM's "Want another one?" (not "anything else").
  const invites = [
    "You've got the mixed kebab. Want another one?",
    "Anything more for you?",
    "Want to add anything?",
  ];
  for (const invite of invites) {
    it(`adds "lamb kebab also" after: "${invite}"`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Mixed Kebab", qty: 1 }]);
      agent.state.lastAssistantText = invite;
      const turn = await agent.handleTurn("lamb kebab also");
      expect(turn.fastPath, invite).toBe("item_added");
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      const names = order!.items.map((i) => i.nameSnapshot);
      expect(names, invite).toContain("Lamb Kebab");
      expect(names, invite).toContain("Mixed Kebab");
    });
  }

  it('additive "too": "chicken kebab too" adds it', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Mixed Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Want another one?";
    const turn = await agent.handleTurn("chicken kebab too");
    expect(turn.fastPath).toBe("item_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.map((i) => i.nameSnapshot)).toContain("Chicken Kebab");
  });

  it('"another mixed kebab" after "Anything else?" adds a second one', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Mixed Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("another mixed kebab");
    expect(turn.fastPath).toBe("item_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const mixed = order!.items.filter((i) => i.nameSnapshot === "Mixed Kebab");
    const totalMixed = mixed.reduce((n, i) => n + i.quantity, 0);
    expect(totalMixed).toBe(2);
  });

  it('a drink added after "Want another one?": "and a coke too"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Mixed Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Want another one?";
    const turn = await agent.handleTurn("and a coke too");
    expect(["drink_added", "item_added"]).toContain(turn.fastPath);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.length).toBe(2);
  });

  // GUARD: a genuine SWAP after an invite must still swap, not add a 2nd item.
  it('a swap after the invite still swaps: "make it a lamb one"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("make it a lamb one");
    expect(turn.fastPath).toBe("item_swap");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => i.nameSnapshot);
    expect(names).toContain("Lamb Kebab");
    expect(names).not.toContain("Chicken Kebab");
    expect(order!.items.length).toBe(1);
  });
});

// Multi-angle bug sweep (audits 2026-09-24) — each of these was a confirmed
// defect: a dropped item, a wrong item, or a corrupted order.
describe("audit fixes 2026-09-24", () => {
  const LLM_FALLBACK: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "[fell to LLM]" };
        yield { type: "stop" as const, reason: "end_turn" as const };
      })();
    },
  };

  // BUG: at the confirm stage, "yeah, and a coke" read as a plain yes ->
  // confirmed + hung up, dropping the coke. Must NOT confirm.
  for (const u of ["yes, and a coke", "yeah also a coke", "yep plus a coke", "yes but make it lamb", "yeah and can I add chips"]) {
    it(`confirm + addition does not confirm: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.mutationSeq = 1; agent.state.summarySeq = 1;
      agent.state.lastAssistantText = "That's 12 dollars 95, takeaway for Dave. Sound good?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath ?? "", u).not.toBe("confirm_yes");
      expect(turn.endCall ?? false, u).toBe(false);
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      expect(order!.status, u).toBe("draft"); // not confirmed
    });
  }

  // GUARD: a plain confirm (even a chatty one) still fast-confirms.
  for (const u of ["yep sounds good", "yeah go on then", "yes that's right", "perfect thanks"]) {
    it(`plain confirm still fast: "${u}"`, async () => {
      const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
      agent.state.mutationSeq = 1; agent.state.summarySeq = 1;
      agent.state.lastAssistantText = "That's 12 dollars 95, takeaway for Dave. Sound good?";
      expect((await agent.handleTurn(u)).fastPath, u).toBe("confirm_yes");
    });
  }

  // BUG: "chicken meatbox with rice" split on "with" and added a phantom $5
  // Rice side on top of the Rice & Salad base. Must not add a Rice side.
  it('"chicken meatbox with rice" adds no phantom Rice side', async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    const turn = await agent.handleTurn("can I get a chicken meatbox with rice");
    expect(turn.fastPath ?? "").not.toMatch(/compound/);
    if (agent.state.draftOrderId) {
      const order = await getOrderWithItems(db, agent.state.draftOrderId);
      expect(order?.items.some((i) => i.nameSnapshot === "Rice")).toBe(false);
    }
  });

  // GUARD: "kebab with a coke" still fast-paths as a compound (with != base).
  it('"a chicken kebab with a coke" still compounds', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("a chicken kebab with a coke");
    expect(turn.fastPath ?? "").toMatch(/compound|item_added|drink_added/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.length).toBe(2);
  });

  // BUG: "small chicken meatbox" stripped "small" and added the full-size
  // ($19.95) meatbox, when a distinct Small Meatbox ($14.95) exists.
  it('"small chicken meatbox" does not silently add the full-size meatbox', async () => {
    const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
    const turn = await agent.handleTurn("a small chicken meatbox please");
    expect(turn.fastPath ?? "").not.toMatch(/item_added|item_pending/);
    expect(agent.state.pendingItem ?? null).toBeNull();
    if (agent.state.draftOrderId) {
      const order = await getOrderWithItems(db, agent.state.draftOrderId);
      expect(order?.items.some((i) => i.nameSnapshot === "Chicken Meatbox")).toBe(false);
    }
  });

  // GUARD: "large chips" (Chips HAS a Size group) still fast-adds.
  it('"large chips" still fast-adds with the size', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("large chips");
    expect(turn.fastPath).toBe("item_added");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Chips")).toBe(true);
  });

  // BUG: a compound with a SOLD-OUT item silently dropped it (and the rest of
  // the queue) then said "Anything else?". Must fall to the LLM instead.
  it("compound with a sold-out item does not silently add the rest", async () => {
    const lamb = await findItemByName(db, "Lamb Kebab");
    await db.query("UPDATE menu_items SET is_sold_out = true WHERE id = $1", [lamb.id]);
    try {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      const turn = await agent.handleTurn("a chicken kebab and a lamb kebab");
      expect(turn.fastPath ?? "").not.toMatch(/compound|item_added/);
      if (agent.state.draftOrderId) {
        const order = await getOrderWithItems(db, agent.state.draftOrderId);
        // nothing silently added while lamb was dropped
        expect(order?.items.length ?? 0).toBe(0);
      }
    } finally {
      await db.query("UPDATE menu_items SET is_sold_out = false WHERE id = $1", [lamb.id]);
    }
  });

  // BUG: a sold-out swap TARGET cut the source line then failed to add,
  // leaving the order short. The source must be restored.
  it("swap to a sold-out target leaves the order intact", async () => {
    const lamb = await findItemByName(db, "Lamb Kebab");
    await db.query("UPDATE menu_items SET is_sold_out = true WHERE id = $1", [lamb.id]);
    try {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Anything else?";
      await agent.handleTurn("make it a lamb one");
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      // the chicken kebab must still be there (not cut with nothing added)
      expect(order!.items.some((i) => i.nameSnapshot === "Chicken Kebab")).toBe(true);
      expect(order!.items.some((i) => i.nameSnapshot === "Lamb Kebab")).toBe(false);
    } finally {
      await db.query("UPDATE menu_items SET is_sold_out = false WHERE id = $1", [lamb.id]);
    }
  });

  // BUG: "no rush"/"no worries" on a single-line order was recorded as a
  // spurious ingredient removal ("No rush"). Reassurances aren't removals.
  for (const u of ["no rush", "no hurry", "no drama", "no worries", "no stress"]) {
    it(`reassurance is not a removal: "${u}"`, async () => {
      const agent = new OrderAgent(LLM_FALLBACK, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Anything else?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath ?? "", u).not.toMatch(/removal|modifier_removed/);
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      const line = order!.items[0]!;
      expect(line.removals.map((r) => r.toLowerCase()), u).not.toContain(u.replace("no ", ""));
    });
  }

  // GUARD: a real ingredient removal ("no onion") still works.
  it('"no onion" still removes the onion', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("no onion");
    expect(turn.fastPath ?? "").toMatch(/removal|modifier_removed/);
  });
});

// Drink "no sugar" phrasings should fast-path to Coke No Sugar, not a ~2s LLM
// turn (India/MB1148 2026-09-26: "Coke no sugar" / "without sugar" hit the brain).
describe("drink no-sugar phrasings fast-path", () => {
  const LLM_FB: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "[LLM]" };
        yield { type: "stop" as const, reason: "end_turn" as const };
      })();
    },
  };
  for (const u of ["a coke no sugar", "coke no sugar please", "can I get a coke with no sugar", "a coke without sugar", "a diet coke", "coke zero"]) {
    it(`"${u}" -> Coke No Sugar, no LLM`, async () => {
      const agent = new OrderAgent(LLM_FB, agentCtx());
      await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }]);
      agent.state.lastAssistantText = "Anything else, or a drink?";
      const turn = await agent.handleTurn(u);
      expect(turn.fastPath ?? "", u).toBe("drink_added");
      const order = await getOrderWithItems(db, agent.state.draftOrderId!);
      const drink = order!.items.find((i) => /soft drink/i.test(i.nameSnapshot));
      expect(drink?.modifiers.map((m) => m.nameSnapshot), u).toContain("Coke No Sugar");
    });
  }
});

// Large-order read-back (India call MB1150 2026-09-26): a garbled line repeated
// "pair of chicken kebab" and each was added -> 7 kebabs / $108 confirmed on the
// total alone. Big orders now read the ITEMS back so it's caught; small orders
// keep the fast total-only close.
describe("large-order read-back (catch an inflated order)", () => {
  it("recites items + 'Correct?' when the order is big by quantity (8 kebabs)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const id = await draftWith(agent, [{ name: "Chicken Kebab", qty: 8 }], "Dave");
    const order = await getOrderWithItems(db, id);
    const close = spokenClose(order!);
    expect(close).toMatch(/8 chicken kebabs/i);
    expect(close).toMatch(/correct\?$/i);
  });

  it("recites items when the order is big by line count (5+ lines)", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const id = await draftWith(
      agent,
      [
        { name: "Chicken Kebab", qty: 1 },
        { name: "Lamb Kebab", qty: 1 },
        { name: "Mixed Kebab", qty: 1 },
        { name: "Falafel Kebab", qty: 1 },
        { name: "Water", qty: 1 },
      ],
      "Dave",
    );
    const order = await getOrderWithItems(db, id);
    const close = spokenClose(order!);
    expect(close).toMatch(/chicken kebab/i);
    expect(close).toMatch(/lamb kebab/i);
    expect(close).toMatch(/correct\?$/i);
  });

  it("GUARD: a small order keeps the fast total-only close ('Sound good?')", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const id = await draftWith(agent, [{ name: "Chicken Kebab", qty: 1 }], "Dave");
    const order = await getOrderWithItems(db, id);
    const close = spokenClose(order!);
    expect(close).toMatch(/sound good\?$/i);
    expect(close.toLowerCase()).not.toContain("kebab"); // no item recital
  });
});

// LLM-turn lag reduction (Kevin AU test 2026-09-25 — a compound with an
// ambiguous item + a hesitation took a ~4.8s LLM turn). Keep these on the fast path.
describe("LLM-lag reduction 2026-09-25", () => {
  it('"a meat kebab" resolves instantly to the Mixed Kebab (no LLM)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("can I get a meat kebab");
    expect(turn.fastPath).toBeTruthy();
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.some((i) => i.nameSnapshot === "Mixed Kebab")).toBe(true);
  });

  it('compound "a chicken kebab and a meat kebab" adds both instantly (no LLM)', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("a chicken kebab and a meat kebab");
    expect(turn.fastPath ?? "").toMatch(/compound|item_added/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    const names = order!.items.map((i) => i.nameSnapshot);
    expect(names).toContain("Chicken Kebab");
    expect(names).toContain("Mixed Kebab");
  });

  it('compound tolerates a hesitation: "a chicken kebab and, um, a coke"', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("a chicken kebab and, um, a coke");
    expect(turn.fastPath ?? "").toMatch(/compound|item_added|drink_added/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.items.length).toBe(2);
  });

  // GUARD: "meat" must only remap inside a KEBAB — "chicken meatbox" is untouched
  // (it recognises the meatbox and asks for its base, not a wrong item).
  it('"a chicken meatbox" is not affected by the meat->mixed remap', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    const turn = await agent.handleTurn("a chicken meatbox");
    expect(turn.fastPath).toBe("item_pending");
    expect(turn.text.toLowerCase()).toMatch(/chips|rice|salad/);
  });
});
