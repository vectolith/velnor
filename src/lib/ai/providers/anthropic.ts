import { requestJson } from "../http";
import {
  CompletionRequest,
  CompletionResult,
  Provider,
  ProviderError,
  ToolCall,
  Turn,
  parseToolArgs,
} from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Convert the neutral transcript into Anthropic content blocks. */
export function toAnthropicMessages(messages: Turn[]): any[] {
  const out: any[] = [];
  for (const turn of messages) {
    if (turn.role === "user") {
      const content: any[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const img of turn.images || []) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.base64 },
        });
      }
      out.push({ role: "user", content: content.length ? content : [{ type: "text", text: "(empty)" }] });
    } else if (turn.role === "assistant") {
      const content: any[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls || []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args || {} });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: turn.toolCallId, content: turn.content }],
      });
    }
  }
  return out;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  constructor(private readonly apiKey: string, private readonly baseUrl = process.env.ANTHROPIC_BASE_URL || API_URL) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, any> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 1200,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const data = await requestJson(this.baseUrl, {
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body,
      provider: "anthropic",
      signal: req.signal,
    });

    if (!Array.isArray(data?.content)) {
      throw new ProviderError(
        "anthropic returned no content: " + JSON.stringify(data).slice(0, 300),
        "anthropic",
        200
      );
    }

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
      if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id || "tool_" + (toolCalls.length + 1),
          name: block.name,
          args: parseToolArgs(block.input),
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data?.usage?.input_tokens ?? 0,
        outputTokens: data?.usage?.output_tokens ?? 0,
      },
      model: data?.model || req.model,
    };
  }
}
