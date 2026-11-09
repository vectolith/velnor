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

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

function normalizeModel(model: string): string {
  return model.replace(/^models\//, "");
}

function toolResultPayload(content: string): any {
  try {
    return { result: JSON.parse(content) };
  } catch {
    return { result: content };
  }
}

/** Convert the neutral transcript into Gemini "contents". */
export function toGeminiContents(messages: Turn[]): any[] {
  const out: any[] = [];
  for (const turn of messages) {
    if (turn.role === "user") {
      const parts: any[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const img of turn.images || []) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
      if (parts.length) out.push({ role: "user", parts });
    } else if (turn.role === "assistant") {
      const parts: any[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.args || {} } });
      }
      if (parts.length) out.push({ role: "model", parts });
    } else {
      out.push({
        role: "user",
        parts: [{ functionResponse: { name: turn.name, response: toolResultPayload(turn.content) } }],
      });
    }
  }
  return out;
}

export class GeminiProvider implements Provider {
  readonly id = "gemini" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.GEMINI_BASE_URL || DEFAULT_BASE
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const url =
      this.baseUrl +
      "/models/" +
      encodeURIComponent(normalizeModel(req.model)) +
      ":generateContent?key=" +
      encodeURIComponent(this.apiKey);

    const body: Record<string, any> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: { maxOutputTokens: req.maxOutputTokens ?? 1200 },
    };
    if (req.tools.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const data = await requestJson(url, { body, provider: "gemini", signal: req.signal });
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      throw new ProviderError(
        "gemini returned no candidates: " + JSON.stringify(data?.promptFeedback || data).slice(0, 300),
        "gemini",
        200
      );
    }

    const parts: any[] = candidate?.content?.parts || [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (typeof part?.text === "string") text += part.text;
      const fc = part?.functionCall;
      if (fc?.name) {
        toolCalls.push({
          id: "gemini_" + (toolCalls.length + 1) + "_" + Math.random().toString(36).slice(2, 8),
          name: fc.name,
          args: parseToolArgs(fc.args),
        });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      },
      model: data?.modelVersion || req.model,
    };
  }
}
