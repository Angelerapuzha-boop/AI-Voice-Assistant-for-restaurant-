import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import { isFinished, isYes, terseReadback } from "../src/agent/fastpath";
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

describe("classifiers", () => {
  it("recognises Australian yes / finish phrases", () => {
    for (const t of ["Yep", "yeah", "that's right", "correct", "yes please", "all good"]) {
      expect(isYes(t), t).toBe(true);
    }
    for (const t of ["Nah", "no that's it", "that's the lot", "that's me", "nothing else", "nah mate"]) {
      expect(isFinished(t), t).toBe(true);
    }
    expect(isYes("no")).toBe(false);
    expect(isFinished("yes")).toBe(false);
    expect(isFinished("actually add a coke")).toBe(false);
  });
});

describe("fast paths (LLM must not be called)", () => {
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
    expect(turn.text).toBe("Anything else?");
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
    expect(turn.text).toBe("Anything else?");
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    for (const item of order!.items) {
      expect(item.modifiers.map((m) => m.nameSnapshot)).toContain("Garlic sauce");
    }
  });

  it('finishes: "nah that\'s it" -> terse read-back when the name is known', async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(
      agent,
      [{ name: "Chicken Meatbox", qty: 2, mods: [["Chicken Meatbox", "Chips & Salad"], ["Chicken Meatbox", "Garlic sauce"]] }],
      "Kev",
    );
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("nah that's it");
    expect(turn.fastPath).toBe("readback");
    expect(turn.text.toLowerCase()).toContain("two chicken meatboxes");
    expect(turn.text.toLowerCase()).toContain("garlic");
    expect(turn.text).toMatch(/Correct\?$/);
  });

  it("asks for a name when finishing without one, then reads back after the answer", async () => {
    const agent = new OrderAgent(FORBIDDEN_LLM, agentCtx());
    await draftWith(agent, [
      { name: "Water", qty: 1 },
    ]);
    agent.state.lastAssistantText = "Anything else?";
    const turn1 = await agent.handleTurn("that's all");
    expect(turn1.fastPath).toBe("ask_name");
    expect(turn1.text).toBe("What name shall I put it under?");
    const turn2 = await agent.handleTurn("it's Kevin");
    expect(turn2.fastPath).toBe("name_readback");
    expect(turn2.text).toMatch(/Correct\?$/);
    const order = await getOrderWithItems(db, agent.state.draftOrderId!);
    expect(order!.customerName).toBe("Kevin");
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
    expect(turn.text).toMatch(/^Done\./);
    expect(turn.text).toMatch(/About \d+ minutes/);
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

describe("fall-through to the LLM", () => {
  const scripted: Llm = {
    stream() {
      return (async function* () {
        yield { type: "text" as const, text: "Falling back." };
        yield { type: "stop" as const, reason: "end_turn" };
      })();
    },
  };

  it("ambiguous option words fall through", async () => {
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
    // "salad" alone matches both bases -> must NOT be guessed
    const turn = await agent.handleTurn("salad");
    expect(turn.fastPath).toBeUndefined();
    expect(turn.text).toBe("Falling back.");
  });

  it("free speech falls through", async () => {
    const agent = new OrderAgent(scripted, agentCtx());
    await draftWith(agent, [{ name: "Water", qty: 1 }]);
    agent.state.lastAssistantText = "Anything else?";
    const turn = await agent.handleTurn("what's in the meatbox actually");
    expect(turn.fastPath).toBeUndefined();
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
