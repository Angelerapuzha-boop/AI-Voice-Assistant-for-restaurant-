import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, env, getDb, getSettings, getDefaultRestaurant, runMigrations, seed } from "@meatbox/core";
import {
  checkBridgeSecret,
  ElevenLabsBridge,
  verifyPostCallSignature,
} from "../src/elevenlabs-bridge";

/**
 * Drives the ElevenLabs bridge (init webhook -> tool calls -> post-call)
 * against the real test database — the same order engine and guards the
 * relay path uses, reached over the platform's webhook shapes.
 */

const NOW = () => new Date("2026-09-09T19:00:00+08:00"); // Wednesday, kitchen open

function makeBridge(deps: ConstructorParameters<typeof ElevenLabsBridge>[0] = {}) {
  return new ElevenLabsBridge({ now: NOW, log: () => undefined, ...deps });
}

beforeAll(async () => {
  (env as { DATABASE_URL: string }).DATABASE_URL = env.TEST_DATABASE_URL;
  const db = getDb();
  await runMigrations(db);
  await seed(db);
});

beforeEach(async () => {
  await getDb().query(
    `TRUNCATE order_item_modifiers, order_items, notification_attempts, call_events, orders, calls CASCADE`,
  );
});

afterAll(async () => {
  await closeDb();
});

describe("auth helpers", () => {
  it("checkBridgeSecret only passes the exact secret", () => {
    expect(checkBridgeSecret("s3cret", "s3cret")).toBe(true);
    expect(checkBridgeSecret("wrong", "s3cret")).toBe(false);
    expect(checkBridgeSecret(undefined, "s3cret")).toBe(false);
    expect(checkBridgeSecret("anything", "")).toBe(false);
  });

  it("verifyPostCallSignature accepts a valid HMAC and rejects tampering", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ type: "post_call_transcription", data: {} });
    const t = Math.floor(Date.now() / 1000);
    const v0 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(verifyPostCallSignature(body, `t=${t},v0=${v0}`, secret)).toBe(true);
    expect(verifyPostCallSignature(body + " ", `t=${t},v0=${v0}`, secret)).toBe(false);
    expect(verifyPostCallSignature(body, `t=${t},v0=${"0".repeat(64)}`, secret)).toBe(false);
    // Stale timestamp outside the tolerance window
    const oldT = t - 60 * 60;
    const oldSig = crypto.createHmac("sha256", secret).update(`${oldT}.${body}`).digest("hex");
    expect(verifyPostCallSignature(body, `t=${oldT},v0=${oldSig}`, secret)).toBe(false);
  });
});

describe("call-init webhook", () => {
  it("creates the call row and returns the per-call prompt + greeting", async () => {
    const bridge = makeBridge();
    const r = await bridge.handleInit({
      conversation_id: "conv_init_1",
      caller_id: "+61412345678",
      call_sid: "CA_init_1",
      agent_id: "agent_x",
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      type: string;
      conversation_config_override: { agent: { prompt: { prompt: string }; first_message: string } };
    };
    expect(body.type).toBe("conversation_initiation_client_data");
    const prompt = body.conversation_config_override.agent.prompt.prompt;
    expect(prompt).toContain("MENU");
    expect(prompt).toContain("PLATFORM NOTES");
    expect(prompt).toContain("+61412345678");
    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const settings = await getSettings(db, restaurant.id);
    expect(body.conversation_config_override.agent.first_message).toBe(settings.aiGreeting);
    const row = await db.query(`SELECT caller_number, twilio_call_sid FROM calls`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ caller_number: "+61412345678", twilio_call_sid: "CA_init_1" });
  });
});

describe("tool webhooks", () => {
  it("takes a full order and refuses to confirm without the caller's yes", async () => {
    const bridge = makeBridge();
    await bridge.handleInit({ conversation_id: "conv_order", caller_id: "+61400000001" });

    // No create_order_draft call: the first add auto-creates the draft.
    const add = await bridge.handleTool("add_order_item", {
      conversation_id: "conv_order",
      menuItemName: "Chicken Meatbox",
      modifierNames: ["Chips & Salad"],
      quantity: 1,
    });
    const addBody = add.body as { lines?: unknown[]; error?: string; orderId?: string };
    expect(addBody.error).toBeUndefined();
    expect(addBody.orderId).toBeTruthy();
    expect(addBody.lines).toHaveLength(1);

    const details = await bridge.handleTool("set_order_details", {
      conversation_id: "conv_order",
      customerName: "Kevin",
    });
    expect((details.body as { error?: string }).error).toBeUndefined();

    // Guard: a non-yes (or missing) caller_final_words can never confirm.
    const noYes = await bridge.handleTool("confirm_order", {
      conversation_id: "conv_order",
      caller_final_words: "how much is that",
    });
    expect((noYes.body as { error?: string }).error).toMatch(/explicit yes/i);
    const missing = await bridge.handleTool("confirm_order", { conversation_id: "conv_order" });
    expect((missing.body as { error?: string }).error).toMatch(/explicit yes/i);

    const confirmed = await bridge.handleTool("confirm_order", {
      conversation_id: "conv_order",
      caller_final_words: "yep",
    });
    const confirmedBody = confirmed.body as { confirmed?: boolean; orderNumber?: string };
    expect(confirmedBody.confirmed).toBe(true);
    expect(confirmedBody.orderNumber).toBeTruthy();

    // A confirmed order lands on the kitchen board as status 'new'.
    const orders = await getDb().query(`SELECT status, public_order_number FROM orders`);
    expect(orders.rows[0].status).toBe("new");
    expect(orders.rows[0].public_order_number).toBe(confirmedBody.orderNumber);
  });

  it("rewrites the pending-item note for platform re-calls and lazily builds sessions", async () => {
    const bridge = makeBridge();
    // No init and no draft: session AND draft must both build themselves.
    const add = await bridge.handleTool("add_order_item", {
      conversation_id: "conv_pending",
      menuItemName: "Chicken Meatbox",
      quantity: 1,
    });
    const body = add.body as { itemSavedAsPending?: boolean; ask?: string; note?: string };
    expect(body.itemSavedAsPending).toBe(true);
    expect(body.ask).toBeTruthy();
    expect(body.note).toMatch(/add_order_item AGAIN/);
    expect(bridge.getSession("conv_pending")).toBeTruthy();
  });

  it("falls back to the name when the model fabricates a well-formed menuItemId (demo-call incident)", async () => {
    const bridge = makeBridge();
    const add = await bridge.handleTool("add_order_item", {
      conversation_id: "conv_fakeid",
      menuItemId: "8983995f-9e6b-4573-8994-01f985959929",
      menuItemName: "Chicken Meatbox",
      modifierNames: ["Chips & Salad"],
      quantity: 1,
    });
    const body = add.body as { lines?: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.lines).toHaveLength(1);
  });

  it("resolves an item NAME passed in the menuItemId field (2026-09-11 live incident)", async () => {
    const bridge = makeBridge();
    const add = await bridge.handleTool("add_order_item", {
      conversation_id: "conv_nameid",
      menuItemId: "Chicken Meatbox",
      modifierNames: ["Chips & Salad"],
      quantity: 1,
    });
    const body = add.body as { lines?: unknown[]; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.lines).toHaveLength(1);
  });
});

describe("post-call finalisation", () => {
  it("writes the transcript, closes the call row and drops the session", async () => {
    const bridge = makeBridge();
    await bridge.handleInit({ conversation_id: "conv_done", caller_id: "+61400000002" });
    const payload = JSON.stringify({
      type: "post_call_transcription",
      data: {
        conversation_id: "conv_done",
        transcript: [
          { role: "agent", message: "Meatbox, what can I get you?", time_in_call_secs: 0 },
          { role: "user", message: "Nothing thanks", time_in_call_secs: 4 },
        ],
      },
    });
    const r = await bridge.handlePostCall(payload);
    expect(r.status).toBe(200);
    const row = await getDb().query(`SELECT ended_at, transcript FROM calls`);
    expect(row.rows[0].ended_at).not.toBeNull();
    const transcript = row.rows[0].transcript as { role: string; text: string }[];
    expect(transcript).toHaveLength(2);
    expect(transcript[0]).toMatchObject({ role: "assistant", text: "Meatbox, what can I get you?" });
    expect(transcript[1]).toMatchObject({ role: "caller", text: "Nothing thanks" });
    expect(bridge.getSession("conv_done")).toBeUndefined();
  });

  it("sweep finalises an idle session by pulling the finished conversation", async () => {
    const bridge = makeBridge({
      fetchConversation: async (id, startedAtMs) => ({
        status: "done",
        transcript: [
          { role: "assistant" as const, text: "Bye", at: new Date(startedAtMs).toISOString() },
        ],
      }),
    });
    await bridge.handleInit({ conversation_id: "conv_idle", caller_id: "+61400000003" });
    await bridge.sweep(Date.now() + 4 * 60_000);
    expect(bridge.getSession("conv_idle")).toBeUndefined();
    const row = await getDb().query(`SELECT ended_at FROM calls`);
    expect(row.rows[0].ended_at).not.toBeNull();
  });

  it("sweep gives up after 10 idle minutes when the platform is unreachable", async () => {
    const bridge = makeBridge({ fetchConversation: async () => null });
    await bridge.handleInit({ conversation_id: "conv_lost", caller_id: "+61400000004" });
    await bridge.sweep(Date.now() + 4 * 60_000);
    expect(bridge.getSession("conv_lost")).toBeTruthy(); // still waiting
    await bridge.sweep(Date.now() + 11 * 60_000);
    expect(bridge.getSession("conv_lost")).toBeUndefined();
    const row = await getDb().query(`SELECT ended_at FROM calls`);
    expect(row.rows[0].ended_at).not.toBeNull();
  });
});
