import type { WebSocket } from "ws";
import {
  appendTranscript,
  buildMenuCatalog,
  endCall,
  getDb,
  getDefaultRestaurant,
  getHours,
  getOrder,
  getSettings,
  markNeedsReview,
  OrderAgent,
  recordCallEvent,
  startCall,
  type CallOutcome,
  type Llm,
} from "@meatbox/core";

/**
 * One ConversationRelay WebSocket session = one phone call.
 *
 * Incoming messages from Twilio:
 *   setup { sessionId, callSid, from, to, ... }
 *   prompt { voicePrompt, last }        — caller speech (final)
 *   interrupt { utteranceUntilInterrupt } — caller barged in
 *   dtmf { digit }
 *   error { description }
 *
 * Outgoing: { type: "text", token, last } streamed to TTS; { type: "end" }.
 */

interface RelaySetup {
  type: "setup";
  sessionId?: string;
  callSid?: string;
  from?: string;
  to?: string;
}

export interface RelaySessionDeps {
  createLlm: (model: string | undefined) => Llm;
  verifyToken: (callSid: string, token: string) => boolean;
  token: string;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Injectable clock (tests); defaults to the real time. */
  now?: () => Date;
  /** Override the post-goodbye grace before hanging up (tests use 0). */
  endDelayMs?: number;
  /** Cache warm-up at setup (default true; tests disable — it would consume scripted LLM turns). */
  prewarm?: boolean;
}

export class RelaySession {
  private agent: OrderAgent | null = null;
  private callId: string | null = null;
  private abort: AbortController | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private consecutiveMisses = 0;
  // STT often chops one caller sentence into several final prompts;
  // merge fragments arriving within a short quiet window into one turn.
  private pendingText = "";
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Hang-up grace: the goodbye must finish PLAYING before we end the call,
  // and the caller speaking during the grace cancels the hang-up entirely.
  private pendingEnd: ReturnType<typeof setTimeout> | null = null;
  private fillerIndex = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: RelaySessionDeps,
  ) {
    ws.on("message", (data: Buffer) => {
      void this.onMessage(data).catch((err) => {
        this.deps.log("relay message handling failed", { error: (err as Error).message });
      });
    });
    ws.on("close", () => {
      void this.onClose().catch(() => undefined);
    });
    ws.on("error", () => {
      void this.onClose().catch(() => undefined);
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async onMessage(data: Buffer): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type) {
      case "setup":
        await this.handleSetup(msg as unknown as RelaySetup);
        break;
      case "prompt": {
        const text = String(msg.voicePrompt ?? "");
        const last = msg.last !== false;
        if (last && text.trim()) {
          this.queueFinal(text.trim());
        }
        break;
      }
      case "interrupt": {
        const spoken = String(msg.utteranceUntilInterrupt ?? "");
        this.cancelPendingEnd();
        this.abort?.abort();
        this.agent?.noteInterruption(spoken);
        if (this.callId) {
          await recordCallEvent(getDb(), this.callId, "interrupt", { spoken });
        }
        break;
      }
      case "error": {
        this.deps.log("relay error from Twilio", { description: msg.description });
        if (this.callId) {
          await recordCallEvent(getDb(), this.callId, "twilio_error", {
            description: msg.description,
          });
        }
        break;
      }
      default:
        break; // dtmf and others intentionally ignored
    }
  }

  private async handleSetup(setup: RelaySetup): Promise<void> {
    const callSid = setup.callSid ?? "";
    if (!this.deps.verifyToken(callSid, this.deps.token)) {
      this.deps.log("relay token invalid — closing", { callSid });
      this.ws.close(4401, "unauthorised");
      return;
    }

    const db = getDb();
    const restaurant = await getDefaultRestaurant(db);
    const [settings, hours, menuCatalog] = await Promise.all([
      getSettings(db, restaurant.id),
      getHours(db, restaurant.id),
      buildMenuCatalog(db, restaurant.id),
    ]);
    const call = await startCall(db, {
      restaurantId: restaurant.id,
      twilioCallSid: callSid || undefined,
      callerNumber: setup.from ?? "",
    });
    this.callId = call.id;
    await recordCallEvent(db, call.id, "setup", { from: setup.from, to: setup.to });

    let llm: Llm;
    try {
      llm = this.deps.createLlm(settings.aiModel || undefined);
    } catch (err) {
      this.deps.log("LLM unavailable", { error: (err as Error).message });
      this.send({
        type: "text",
        token:
          "Sorry, our ordering assistant isn't available right now. Please call back shortly.",
        last: true,
      });
      this.send({ type: "end" });
      await endCall(db, call.id, { status: "failed", outcome: "NO_ORDER" });
      return;
    }

    this.agent = new OrderAgent(llm, {
      db,
      restaurant,
      settings,
      hours,
      callId: call.id,
      // Browser test calls arrive as "client:browser-..." — that's not a
      // phone number, so treat it as no caller ID (the AI asks for a
      // contact number if the caller orders, and no SMS is attempted).
      callerNumber: setup.from?.startsWith("client:") ? undefined : setup.from,
      now: this.deps.now ?? (() => new Date()),
      menuCatalog,
    });
    // The welcome greeting is spoken by ConversationRelay itself
    // (welcomeGreeting attribute); record it in the transcript.
    await appendTranscript(db, call.id, {
      role: "assistant",
      text: settings.aiGreeting,
      at: new Date().toISOString(),
    });
    // Warm the prompt cache while the greeting plays — first order
    // sentence then answers in roughly half the time.
    if (this.deps.prewarm !== false) void this.agent.prewarm();
  }

  /** Merge rapid-fire STT finals into one caller turn (quiet window). */
  private queueFinal(text: string): void {
    this.cancelPendingEnd(); // caller spoke — we're not hanging up
    this.abort?.abort(); // new speech supersedes any in-flight reply
    this.pendingText = this.pendingText ? `${this.pendingText} ${text}` : text;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    // Adaptive quiet window: a substantial utterance (3+ words) is very
    // likely complete — process fast. Short fragments ("nah,") keep the
    // longer window so a mid-sentence pause doesn't split the turn.
    const words = this.pendingText.trim().split(/\s+/).length;
    this.pendingTimer = setTimeout(
      () => {
        const merged = this.pendingText.trim();
        this.pendingText = "";
        this.pendingTimer = null;
        if (merged) this.enqueueTurn(merged);
      },
      words >= 3 ? 150 : 400,
    );
  }

  /** Serialise turns — a new final prompt aborts a stale in-flight turn. */
  private enqueueTurn(text: string): void {
    this.turnQueue = this.turnQueue.then(() => this.runTurn(text)).catch(() => undefined);
  }

  private async runTurn(text: string): Promise<void> {
    if (!this.agent || this.closed) return;
    const db = getDb();
    if (this.callId) {
      await appendTranscript(db, this.callId, {
        role: "caller",
        text,
        at: new Date().toISOString(),
      });
    }

    this.abort = new AbortController();
    const turnStarted = Date.now();
    let firstTokenMs: number | null = null;
    let fillerSent = false;
    // Dead-air breaker: complete silence is worse than a small human
    // sound. Rotating acknowledgments avoid the identical-word tic.
    const filler = setTimeout(() => {
      if (firstTokenMs === null && !this.abort?.signal.aborted) {
        fillerSent = true;
        const acks = ["Righto, ", "Yep, ", "Sure, ", "Okay, "];
        this.send({ type: "text", token: acks[this.fillerIndex++ % acks.length]!, last: false });
      }
    }, 1100);
    // Second stage for rare tool-heavy turns: never leave the caller in
    // long silence after the first ack.
    const filler2 = setTimeout(() => {
      if (firstTokenMs === null && !this.abort?.signal.aborted) {
        this.send({ type: "text", token: "just getting that in for you. ", last: false });
      }
    }, 5500);
    const result = await this.agent.handleTurn(
      text,
      {
        onText: (token) => {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - turnStarted;
            clearTimeout(filler);
            clearTimeout(filler2);
          }
          this.send({ type: "text", token, last: false });
        },
      },
      this.abort.signal,
    );
    clearTimeout(filler);
    clearTimeout(filler2);
    this.send({ type: "text", token: "", last: true });
    const turnMs = Date.now() - turnStarted;
    if (this.callId) {
      // Permanent per-turn latency record; slow turns are flagged so call
      // quality is auditable long after the call.
      await recordCallEvent(db, this.callId, turnMs > 8000 ? "slow_turn" : "turn_metrics", {
        turnMs,
        firstTokenMs,
        fillerSent,
        toolCalls: result.toolCalls.length,
        interrupted: result.interrupted,
        fastPath: result.fastPath ?? null,
        assistantWords: result.text ? result.text.trim().split(/\s+/).length : 0,
      });
    }

    if (this.callId) {
      if (result.text) {
        await appendTranscript(db, this.callId, {
          role: "assistant",
          text: result.text,
          at: new Date().toISOString(),
        });
      }
      for (const call of result.toolCalls) {
        await recordCallEvent(db, this.callId, "tool_call", {
          name: call.name,
          input: call.input,
          result: call.result,
        });
      }
      if (result.error) {
        await recordCallEvent(db, this.callId, "agent_error", { error: result.error });
      }
    }

    if (result.error) this.consecutiveMisses++;
    else if (!result.interrupted) this.consecutiveMisses = 0;

    if (result.endCall || this.consecutiveMisses >= 3) {
      // Grace period sized to the goodbye so its audio finishes playing
      // (~3 words/sec) — and if the caller speaks meanwhile, the hang-up
      // is cancelled and the conversation continues.
      const forceReview = this.consecutiveMisses >= 3;
      const words = result.text ? result.text.trim().split(/\s+/).length : 0;
      const delay = this.deps.endDelayMs ?? Math.min(9000, 2000 + words * 340);
      this.pendingEnd = setTimeout(() => {
        this.pendingEnd = null;
        void (async () => {
          await this.finalise(forceReview ? "NEEDS_REVIEW" : undefined);
          this.send({ type: "end" });
        })().catch(() => undefined);
      }, delay);
    }
  }

  private cancelPendingEnd(): void {
    if (this.pendingEnd) {
      clearTimeout(this.pendingEnd);
      this.pendingEnd = null;
      // The goodbye was pre-empted — the call carries on.
      if (this.agent) this.agent.state.endCallRequested = false;
    }
  }

  private async finalise(forceOutcome?: CallOutcome): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const db = getDb();
    if (!this.callId) return;

    const state = this.agent?.state;
    let outcome: CallOutcome = forceOutcome ?? state?.outcome ?? "NO_ORDER";

    // Draft order left behind by a dropped/failed call → needs review,
    // but a CONFIRMED order always survives untouched. A draft awaiting the
    // customer's tap on a review link is EXPECTED to outlive the call: leave
    // it alone (the expiry sweep cancels it if never confirmed).
    if (state?.draftOrderId && !state.reviewLinkSent) {
      const order = await getOrder(db, state.draftOrderId);
      if (order && order.status === "draft") {
        if (order.subtotalCents > 0 || order.customerName) {
          await markNeedsReview(db, order.id, "Call ended before the order was confirmed.");
          if (outcome === "NO_ORDER") outcome = "CALL_DROPPED";
        }
      }
    }
    await endCall(db, this.callId, { status: "completed", outcome });
  }

  private async onClose(): Promise<void> {
    this.abort?.abort();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.pendingEnd) clearTimeout(this.pendingEnd);
    await this.finalise();
  }
}
