// Provider-neutral chat/tool types.
//
// Every adapter speaks this dialect, so the agent loop is written once and
// Gemini, OpenAI and Anthropic all honour the same tool declarations.

export type ProviderId = "openai" | "gemini" | "anthropic";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface ImagePart {
  mimeType: string;
  base64: string;
}

export type Turn =
  | { role: "user"; text: string; images?: ImagePart[] }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Turn[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** JSON schema of the reply when the provider supports structured output. */
  responseSchema?: Record<string, any>;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Provider-reported model name (may differ from the requested alias). */
  model: string;
}

export interface Provider {
  readonly id: ProviderId;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Tool arguments arrive as JSON text from OpenAI/Gemini; never let a bad
 * payload crash the loop. */
export function parseToolArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
