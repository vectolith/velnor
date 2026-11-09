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

const API_URL = "https://api.openai.com/v1/chat/completions";

function contentParts(turn: Extract<Turn, { role: "user" }>): any[] | string {
  if (!turn.images || turn.images.length === 0) return turn.text;
  return [
    { type: "text", text: turn.text || "Describe the attached image." },
    ...turn.images.map((img) => ({
      type: "image_url",
      image_url: { url: "data:" + img.mimeType + ";base64," + img.base64 },
    })),
  ];
}

/** Convert the neutral transcript into OpenAI chat messages. */
export function toOpenAIMessages(system: string, messages: Turn[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const turn of messages) {
    if (turn.role === "user") {
      out.push({ role: "user", content: contentParts(turn) });
    } else if (turn.role === "assistant") {
      const calls = turn.toolCalls || [];
      out.push({
        role: "assistant",
        content: turn.text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: turn.toolCallId, content: turn.content });
    }
  }
  return out;
}

export class OpenAIProvider implements Provider {
  readonly id = "openai" as const;
  constructor(private readonly apiKey: string, private readonly baseUrl = process.env.OPENAI_BASE_URL || API_URL) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, any> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      max_completion_tokens: req.maxOutputTokens ?? 1200,
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (req.responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "reply", schema: req.responseSchema, strict: false },
      };
    }

    const data = await requestJson(this.baseUrl, {
      headers: { authorization: "Bearer " + this.apiKey },
      body,
      provider: "openai",
      signal: req.signal,
    });

    const choice = data?.choices?.[0]?.message;
    if (!choice) {
      throw new ProviderError("openai returned no choices", "openai", 200);
    }
    const toolCalls: ToolCall[] = (choice.tool_calls || [])
      .filter((c: any) => c?.type === "function")
      .map((c: any, i: number) => ({
        id: c.id || "call_" + i,
        name: c.function?.name || "",
        args: parseToolArgs(c.function?.arguments),
      }));

    return {
      text: typeof choice.content === "string" ? choice.content : "",
      toolCalls,
      usage: {
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
      },
      model: data?.model || req.model,
    };
  }
}
