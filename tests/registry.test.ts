import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderChain, estimateCostUsd } from "../src/lib/ai/registry";

test("preferred provider goes first, unkeyed providers are skipped", () => {
  const chain = buildProviderChain({
    preferred: "anthropic",
    keys: { gemini: "g", anthropic: "a" },
    models: {},
  });
  assert.deepEqual(chain.map((c) => c.id), ["anthropic", "gemini"]);
});

test("auto uses the default priority", () => {
  const chain = buildProviderChain({
    preferred: "auto",
    keys: { openai: "o", anthropic: "a" },
    models: {},
  });
  assert.deepEqual(chain.map((c) => c.id), ["openai", "anthropic"]);
});

test("no keys means no chain (built-in fallback handles it)", () => {
  assert.equal(buildProviderChain({ preferred: "auto", keys: {}, models: {} }).length, 0);
});

test("cost estimate uses per-model pricing", () => {
  const cost = estimateCostUsd("gpt-4o", 1_000_000, 1_000_000);
  assert.equal(cost, 12.5);
  assert.equal(estimateCostUsd("unknown-model", 1000, 1000), 0);
});
