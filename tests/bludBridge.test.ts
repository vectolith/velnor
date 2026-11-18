import test from "node:test";
import assert from "node:assert/strict";
import { delegateBrowserTaskToBlud } from "../src/lib/tools/bludBridge";

test("returns failure when task description is empty", async () => {
  const result = await delegateBrowserTaskToBlud({ task: "   " });
  assert.equal(result.status, "failure");
  assert.match(result.summary, /no task instruction provided/i);
});

test("returns offline status when Blud RPC endpoint is unreachable", async () => {
  process.env.BLUD_INTERNAL_RPC_URL = "http://127.0.0.1:59999/api/nonexistent";
  const result = await delegateBrowserTaskToBlud({
    task: "Navigate to example.com and verify heading",
    timeoutMs: 1500,
  });
  assert.ok(result.status === "offline" || result.status === "failure");
  assert.ok(result.verifiedAtUtc);
});

test("does not inherit Velnor credentials for the optional Blud integration", async () => {
  const previousRpcUrl = process.env.BLUD_INTERNAL_RPC_URL;
  const previousBludKey = process.env.BLUD_INTERNAL_KEY;
  const previousVelnorSecret = process.env.VELNOR_SHARED_SECRET;
  delete process.env.BLUD_INTERNAL_RPC_URL;
  delete process.env.BLUD_INTERNAL_KEY;
  process.env.VELNOR_SHARED_SECRET = "velnor-only-secret";

  try {
    const result = await delegateBrowserTaskToBlud({ task: "Run an optional browser task" });
    assert.equal(result.status, "offline");
    assert.match(result.error || "", /dedicated BLUD_INTERNAL_KEY/i);
  } finally {
    if (previousRpcUrl === undefined) delete process.env.BLUD_INTERNAL_RPC_URL;
    else process.env.BLUD_INTERNAL_RPC_URL = previousRpcUrl;
    if (previousBludKey === undefined) delete process.env.BLUD_INTERNAL_KEY;
    else process.env.BLUD_INTERNAL_KEY = previousBludKey;
    if (previousVelnorSecret === undefined) delete process.env.VELNOR_SHARED_SECRET;
    else process.env.VELNOR_SHARED_SECRET = previousVelnorSecret;
  }
});
