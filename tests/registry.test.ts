import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderChain, estimateCostUsd, getExplicitProviderConfigurationError } from "../src/lib/ai/registry";

test("explicit provider selection does not substitute another configured provider", () => {
  const chain = buildProviderChain({
    preferred: "anthropic",
    keys: { gemini: "g", anthropic: "a" },
    models: {},
  });
  assert.deepEqual(chain.map((c) => c.id), ["anthropic"]);
});

test("auto selects one configured provider using stable priority", () => {
  const chain = buildProviderChain({
    preferred: "auto",
    keys: { openai: "o", anthropic: "a" },
    models: {},
  });
  assert.deepEqual(chain.map((c) => c.id), ["openai"]);
});

test("cross-provider failover requires explicit opt-in", () => {
  const chain = buildProviderChain({
    preferred: "anthropic",
    keys: { gemini: "g", anthropic: "a", openai: "o" },
    models: {},
    allowFallback: true,
  });
  assert.deepEqual(chain.map((c) => c.id), ["anthropic", "gemini", "openai"]);
});

test("an unavailable explicitly selected provider produces no substitute", () => {
  const chain = buildProviderChain({
    preferred: "anthropic",
    keys: { gemini: "g", openai: "o" },
    models: {},
  });
  assert.deepEqual(chain, []);
});

test("no keys means no chain (built-in fallback handles it)", () => {
  assert.equal(buildProviderChain({ preferred: "auto", keys: {}, models: {} }).length, 0);
});

test("cost estimate uses per-model pricing", () => {
  const cost = estimateCostUsd("gpt-4o", 1_000_000, 1_000_000);
  assert.equal(cost, 12.5);
  assert.equal(estimateCostUsd("unknown-model", 1000, 1000), 0);
});


test("an explicitly selected provider with no key returns a configuration error instead of fallback", () => {
  assert.match(
    getExplicitProviderConfigurationError("anthropic", { gemini: "g", openai: "o" }) || "",
    /explicitly selected.*no API key/i,
  );
  assert.equal(getExplicitProviderConfigurationError("auto", {}), null);
  assert.equal(getExplicitProviderConfigurationError("anthropic", { anthropic: "a" }), null);
});

test("an unsupported non-auto provider selection fails closed", () => {
  assert.match(
    getExplicitProviderConfigurationError("unknown-provider", { gemini: "g" }) || "",
    /unsupported explicitly selected/i,
  );
});
