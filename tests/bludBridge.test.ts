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
