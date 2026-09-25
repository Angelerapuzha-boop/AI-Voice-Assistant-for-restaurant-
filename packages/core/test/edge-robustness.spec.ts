import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { OrderAgent } from "../src/agent/engine";
import type { AgentContext } from "../src/agent/tools";
import type { Llm } from "../src/agent/llm";
import { resetTransactionalData, setupTestDb, type TestContext } from "./helpers";
import { getOrderWithItems } from "../src/domain/orders";
let ctx: TestContext; let db: pg.Pool;
beforeAll(async () => { ctx = await setupTestDb(); db = ctx.db; });
afterAll(async () => { await db.end(); });
beforeEach(async () => { await resetTransactionalData(db); });
function agentCtx(): AgentContext { return { db, restaurant: ctx.restaurant, settings: { ...ctx.settings, customerSmsEnabled: true }, hours: ctx.hours, callerNumber: "+61400000001", now: () => new Date("2026-09-09T19:00:00+08:00") }; }
const LLM: Llm = { stream() { return (async function*(){ yield {type:"text" as const, text:"[LLM]"}; yield {type:"stop" as const, reason:"end_turn" as const}; })(); } };

// From-all-sides inputs. NONE may throw, and none may silently add a WRONG item.
// Questions/dietary/timing/social go to the LLM (fine); ordering ones handle.
const inputs = [
  // questions
  "how much is a chicken kebab","how long will it be","do you deliver","are you open","where are you",
  "do you take card","is it halal","what's in the meatbox","any specials on","can I pay cash",
  "how much so far","whats the total","do you do gluten free","have you got vegetarian",
  // dietary / mods
  "no onion","no nuts please","dairy free","extra spicy","not too spicy",
  // timing
  "can I pick it up at 6","in about an hour","as soon as possible","tonight at 7",
  // cancel / restart / correction
  "cancel everything","start over","scrap the whole order","actually forget it","wait no",
  // social / greeting / noise / garble
  "hi how are you","g'day mate","hello hello","yeah nah","um what was i saying","asdfghjk",
  "","...","you there","still there","hello?",
  // very long / rambling
  "yeah look I was thinking maybe I might get something but I'm not really sure what yet",
];
describe("EDGE: from all sides — no crash, no wrong add", () => {
  for (const say of inputs) {
    it(`handles "${say.slice(0,30)}"`, async () => {
      const agent = new OrderAgent(LLM, agentCtx());
      let turn; let threw = false;
      try { turn = await agent.handleTurn(say); } catch { threw = true; }
      expect(threw, `THREW on "${say}"`).toBe(false);
      // no bogus item silently committed for a non-order input
      const order = agent.state.draftOrderId ? await getOrderWithItems(db, agent.state.draftOrderId) : null;
      expect((order?.items.length ?? 0), `wrong add on "${say}": ${order?.items.map(i=>i.nameSnapshot).join(",")}`).toBe(0);
    });
  }
});
