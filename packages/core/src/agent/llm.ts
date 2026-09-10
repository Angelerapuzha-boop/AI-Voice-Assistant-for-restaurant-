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
      // Prompt caching: stable prefix is tools -> system -> conversation.
      // Breakpoints on the last tool, the system prompt, and the last
      // message (3 of the 4 allowed) give near-full cache reuse across the
      // many round-trips of a phone call, cutting latency and input cost.
      // Never mutate the caller's history — build request-local copies.
      const tools = (params.tools as Anthropic.Tool[]).map((tool, i, arr) =>
        i === arr.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool,
      );
      const msgs = params.messages as Anthropic.MessageParam[];
      const prepared = msgs.map((m, i) => {
        if (i !== msgs.length - 1) return m;
        const blocks: Record<string, unknown>[] =
          typeof m.content === "string"
            ? [{ type: "text", text: m.content }]
            : (m.content as unknown as Record<string, unknown>[]).slice();
        if (blocks.length === 0) return m;
        blocks[blocks.length - 1] = {
          ...blocks[blocks.length - 1],
          cache_control: { type: "ephemeral" },
        };
        return { ...m, content: blocks } as unknown as Anthropic.MessageParam;
      });

      const request = {
        model: useModel,
        max_tokens: params.maxTokens ?? 1024,
        system: [
          {
            type: "text",
            text: params.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: prepared,
        tools,
      } as Parameters<typeof client.messages.stream>[0];
      // Low effort: phone ordering is simple and latency-critical — this
      // keeps Sonnet's instruction-following while answering much faster.
      (request as unknown as Record<string, unknown>).output_config = { effort: "low" };
      const stream = client.messages.stream(request, { signal: params.signal });

      // Track tool_use blocks so we can emit them complete.
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let cacheWrite = 0;

      for await (const event of stream) {
        if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
          cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
          cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
        } else if (event.type === "message_delta" && event.usage) {
          outputTokens = event.usage.output_tokens;
        }
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
      // One line per model round-trip so real per-call cost can be read
      // from the service logs (input/output token counts).
      console.log(
        `[llm-usage] model=${useModel} input=${inputTokens} output=${outputTokens} cacheRead=${cacheRead} cacheWrite=${cacheWrite}`,
      );
    },
  };
}
