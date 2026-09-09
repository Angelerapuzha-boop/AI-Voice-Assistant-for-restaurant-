import { buildSystemPrompt } from "./prompt";
import {
  executeTool,
  initialAgentState,
  TOOL_DEFS,
  type AgentContext,
  type AgentState,
} from "./tools";
import type { Llm, LlmMessage } from "./llm";

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface TurnHandlers {
  /** Streaming text tokens (feed straight to TTS). */
  onText?: (token: string) => void;
  onToolCall?: (call: ToolCallRecord) => void;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: ToolCallRecord[];
  endCall: boolean;
  interrupted: boolean;
  error?: string;
}

const MAX_TOOL_ITERATIONS = 10;

/**
 * One agent per phone call (or simulator session). Holds conversation
 * history and order state; each caller utterance is one handleTurn().
 */
export class OrderAgent {
  readonly state: AgentState;
  private readonly messages: LlmMessage[] = [];
  private readonly system: string;
  private consecutiveFailures = 0;

  constructor(
    private readonly llm: Llm,
    private readonly ctx: AgentContext,
  ) {
    this.state = initialAgentState();
    // Built once per call: a stable system prompt keeps the prompt cache
    // valid across every turn and tool round-trip of the conversation.
    // (Live open/closed state always comes from tools, not this snapshot.)
    this.system = buildSystemPrompt({
      restaurant: ctx.restaurant,
      settings: ctx.settings,
      hours: ctx.hours,
      callerNumber: ctx.callerNumber,
      now: ctx.now(),
    });
  }

  get history(): readonly LlmMessage[] {
    return this.messages;
  }

  async handleTurn(
    userText: string,
    handlers: TurnHandlers = {},
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    const system = this.system;

    this.messages.push({ role: "user", content: userText });

    const toolCalls: ToolCallRecord[] = [];
    let spokenText = "";

    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const blocks: unknown[] = [];
        let currentText = "";
        const pendingTools: { id: string; name: string; input: Record<string, unknown> }[] = [];

        for await (const event of this.llm.stream({
          system,
          messages: this.messages,
          tools: TOOL_DEFS,
          signal,
        })) {
          if (event.type === "text") {
            currentText += event.text;
            spokenText += event.text;
            handlers.onText?.(event.text);
          } else if (event.type === "tool_use") {
            if (currentText) {
              blocks.push({ type: "text", text: currentText });
              currentText = "";
            }
            blocks.push({ type: "tool_use", id: event.id, name: event.name, input: event.input });
            pendingTools.push(event);
          }
        }
        if (currentText) blocks.push({ type: "text", text: currentText });

        if (pendingTools.length === 0) {
          if (blocks.length > 0) this.messages.push({ role: "assistant", content: blocks });
          this.consecutiveFailures = 0;
          return { text: spokenText, toolCalls, endCall: this.state.endCallRequested, interrupted: false };
        }

        this.messages.push({ role: "assistant", content: blocks });
        const resultBlocks: unknown[] = [];
        for (const tool of pendingTools) {
          const result = await executeTool(this.ctx, this.state, tool.name, tool.input);
          const record = { name: tool.name, input: tool.input, result };
          toolCalls.push(record);
          handlers.onToolCall?.(record);
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: tool.id,
            content: JSON.stringify(result),
          });
        }
        this.messages.push({ role: "user", content: resultBlocks });

        if (this.state.endCallRequested) {
          // Goodbye was spoken before end_call; no further LLM round needed.
          this.consecutiveFailures = 0;
          return { text: spokenText, toolCalls, endCall: true, interrupted: false };
        }
      }

      // Tool-loop runaway guard
      this.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Sorry, let me just double-check that for you." }],
      });
      return {
        text: spokenText || "Sorry, let me just double-check that for you.",
        toolCalls,
        endCall: this.state.endCallRequested,
        interrupted: false,
      };
    } catch (err) {
      if (signal?.aborted) {
        // Caller barged in: keep what was actually said as history.
        if (spokenText) {
          this.messages.push({ role: "assistant", content: [{ type: "text", text: spokenText }] });
        } else {
          this.messages.pop(); // nothing said; drop the dangling structure
        }
        return { text: spokenText, toolCalls, endCall: false, interrupted: true };
      }
      this.consecutiveFailures++;
      // Keep history consistent: model never answered this turn.
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        this.messages.pop();
      }
      const message =
        this.consecutiveFailures >= 2
          ? "Sorry, I'm having trouble on my end right now. Could you call us back in a few minutes? Sorry about that."
          : "Sorry, I missed that — could you say it again?";
      return {
        text: message,
        toolCalls,
        endCall: this.consecutiveFailures >= 2,
        interrupted: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * ConversationRelay tells us how much of the last reply was actually
   * spoken before the caller interrupted; trim history to match.
   */
  noteInterruption(utteranceUntilInterrupt: string): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
    const textBlocks = (last.content as { type: string; text?: string }[]).filter(
      (b) => b.type === "text",
    );
    if (textBlocks.length === 0) return;
    const lastBlock = textBlocks[textBlocks.length - 1]!;
    if (utteranceUntilInterrupt && lastBlock.text && lastBlock.text.includes(utteranceUntilInterrupt)) {
      lastBlock.text =
        lastBlock.text.slice(0, lastBlock.text.indexOf(utteranceUntilInterrupt)) +
        utteranceUntilInterrupt;
    }
  }
}
