import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OpenAIProvider } from "./providers/openai";
import { Provider, ProviderId } from "./providers/types";

export interface ProviderSlot {
  id: ProviderId;
  model: string;
  apiKey: string;
}

/**
 * Defaults are env-overridable because model names move fast. These are the
 * names that were current when this was written; set VELNOR_MODEL_* to pin.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: process.env.VELNOR_MODEL_GEMINI || "gemini-2.5-flash",
  openai: process.env.VELNOR_MODEL_OPENAI || "gpt-4o",
  anthropic: process.env.VELNOR_MODEL_ANTHROPIC || "claude-sonnet-4-20250514",
};

export function createProvider(id: ProviderId, apiKey: string): Provider {
  switch (id) {
    case "openai":
      return new OpenAIProvider(apiKey);
    case "gemini":
      return new GeminiProvider(apiKey);
    case "anthropic":
      return new AnthropicProvider(apiKey);
    default:
      throw new Error("Unsupported provider: " + String(id));
  }
}

/**
 * Ordered list of providers to try. "auto" means: requested provider first (if
 * keyed), then the others by configured priority. The agent walks this list
 * until one answers.
 */
export function buildProviderChain(params: {
  preferred: string;
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
}): ProviderSlot[] {
  const order: ProviderId[] = ["gemini", "openai", "anthropic"];
  const preferred = params.preferred as ProviderId;
  const ordered =
    preferred && preferred !== ("auto" as any) && order.includes(preferred)
      ? [preferred, ...order.filter((p) => p !== preferred)]
      : order;

  const chain: ProviderSlot[] = [];
  for (const id of ordered) {
    const apiKey = params.keys[id];
    if (!apiKey) continue;
    chain.push({
      id,
      apiKey,
      model: params.models[id] || DEFAULT_MODELS[id],
    });
  }
  return chain;
}

/** USD per 1M tokens, [input, output]. Unknown models return zero. */
const PRICES: Array<[RegExp, [number, number]]> = [
  [/^gemini-2\.5-pro/, [1.25, 10]],
  [/^gemini-2\.5-flash/, [0.3, 2.5]],
  [/^gemini-2\.0-flash/, [0.1, 0.4]],
  [/^gpt-4o-mini/, [0.15, 0.6]],
  [/^gpt-4o/, [2.5, 10]],
  [/^gpt-4\.1/, [2, 8]],
  [/^o[134](-mini)?/, [1.5, 6]],
  [/^claude-opus-4/, [15, 75]],
  [/^claude-sonnet-4/, [3, 15]],
  [/^claude-haiku/, [0.8, 4]],
  [/^claude-3-5-haiku/, [0.8, 4]],
  [/^claude-3/, [3, 15]],
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const match = PRICES.find(([re]) => re.test(model || ""));
  if (!match) return 0;
  const [inPrice, outPrice] = match[1];
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}
