import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

/**
 * Thin streaming abstraction over the Claude API so the agent engine can be
 * tested with a scripted fake and the voice service can stream tokens to TTS.
 */

export type LlmStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "stop"; reason: string };

export interface LlmMessage {
  role: "user" | "assistant";
  content: unknown; // Anthropic content blocks or plain string
}

export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmParams {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Llm {
  stream(params: LlmParams): AsyncIterable<LlmStreamEvent>;
}

export function createAnthropicLlm(model?: string): Llm {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const useModel = model || env.ANTHROPIC_MODEL;

  return {
    async *stream(params: LlmParams): AsyncIterable<LlmStreamEvent> {
      const stream = client.messages.stream(
        {
          model: useModel,
          max_tokens: params.maxTokens ?? 1024,
          system: params.system,
          messages: params.messages as Anthropic.MessageParam[],
          tools: params.tools as Anthropic.Tool[],
        },
        { signal: params.signal },
      );

      // Track tool_use blocks so we can emit them complete.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              json: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const block = toolBlocks.get(event.index);
            if (block) block.json += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const block = toolBlocks.get(event.index);
          if (block) {
            let input: Record<string, unknown> = {};
            try {
              input = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
            } catch {
              // malformed tool JSON — surface as empty input, executor will reject
            }
            yield { type: "tool_use", id: block.id, name: block.name, input };
            toolBlocks.delete(event.index);
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            yield { type: "stop", reason: event.delta.stop_reason };
          }
        }
      }
    },
  };
}
