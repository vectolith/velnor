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
 * Defaults are env-overridable. Production deployments should pin these
 * values to the exact model identifiers they have approved.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: process.env.VELNOR_MODEL_GEMINI || "gemini-3.8-flash",
  openai: process.env.VELNOR_MODEL_OPENAI || "gpt-4o",
  anthropic: process.env.VELNOR_MODEL_ANTHROPIC || "claude-sonnet-4-6",
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
 * Resolve the configured provider without silently substituting another
 * provider/model. "auto" selects the first configured provider in stable
 * priority order. Cross-provider failover is available only when explicitly
 * enabled by deployment policy.
 */
export function buildProviderChain(params: {
  preferred: string;
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  allowFallback?: boolean;
}): ProviderSlot[] {
  const order: ProviderId[] = ["gemini", "openai", "anthropic"];
  const preferred = params.preferred as ProviderId;
  const selected = order.includes(preferred) ? preferred : order.find((id) => !!params.keys[id]);
  if (!selected || !params.keys[selected]) return [];

  const ordered = params.allowFallback
    ? [selected, ...order.filter((id) => id !== selected)]
    : [selected];

  return ordered.flatMap((id) => {
    const apiKey = params.keys[id];
    if (!apiKey) return [];
    return [{
      id,
      apiKey,
      model: params.models[id] || DEFAULT_MODELS[id],
    }];
  });
}

/** USD per 1M tokens, [input, output]. Unknown models return zero. */
const PRICES: Array<[RegExp, [number, number]]> = [
  [/^gemini-3\.8-flash/, [0.75, 3.75]],
  [/^gemini-3\.6-flash/, [0.75, 3.75]],
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
