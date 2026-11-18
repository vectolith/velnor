import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { delegateBrowserTaskToBlud } from "../src/lib/tools/bludBridge";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.BLUD_INTERNAL_KEY;
const originalSharedSecret = process.env.VELNOR_SHARED_SECRET;
const originalRpcUrl = process.env.BLUD_INTERNAL_RPC_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.BLUD_INTERNAL_KEY;
  else process.env.BLUD_INTERNAL_KEY = originalSecret;
  if (originalSharedSecret === undefined) delete process.env.VELNOR_SHARED_SECRET;
  else process.env.VELNOR_SHARED_SECRET = originalSharedSecret;
  if (originalRpcUrl === undefined) delete process.env.BLUD_INTERNAL_RPC_URL;
  else process.env.BLUD_INTERNAL_RPC_URL = originalRpcUrl;
});

test("returns failure when task description is empty", async () => {
  const result = await delegateBrowserTaskToBlud({ task: "   " });
  assert.equal(result.status, "failure");
  assert.match(result.summary, /no task instruction provided/i);
});

test("refuses to call Blud when internal service authentication is not configured", async () => {
  delete process.env.BLUD_INTERNAL_KEY;
  delete process.env.VELNOR_SHARED_SECRET;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("unexpected", { status: 200 });
  };

  const result = await delegateBrowserTaskToBlud({ task: "Inspect the current page" });
  assert.equal(result.status, "failure");
  assert.match(result.error || "", /must be configured/i);
  assert.equal(called, false);
});

test("rejects success responses without a verifiable execution receipt", async () => {
  process.env.BLUD_INTERNAL_KEY = "test-internal-secret";
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-blud-key"), "test-internal-secret");
    return new Response(
      JSON.stringify({
        status: "success",
        message: "Task accepted",
        currentUrl: "https://example.com",
        data: { task: "Inspect the current page" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const result = await delegateBrowserTaskToBlud({ task: "Inspect the current page" });
  assert.equal(result.status, "failure");
  assert.match(result.error || "", /executionReceipt/i);
  assert.equal(result.currentUrl, undefined);
});

test("accepts success only with a structurally valid completion receipt", async () => {
  process.env.BLUD_INTERNAL_KEY = "test-internal-secret";
  const completedAtUtc = "2026-11-18T09:00:00.000Z";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: "success",
        message: "Page inspected",
        sessionRef: "wrun_internal_1",
        executionReceipt: {
          taskId: "verified-task",
          state: "completed",
          completedAtUtc,
          finalUrl: "https://example.com/",
          evidenceSha256: "a".repeat(64),
        },
        data: { title: "Example Domain" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const result = await delegateBrowserTaskToBlud({ task: "Inspect the current page" });
  assert.equal(result.status, "success");
  assert.equal(result.currentUrl, "https://example.com/");
  assert.equal(result.observedAtUtc, completedAtUtc);
  assert.deepEqual(result.extractedData, { title: "Example Domain" });
  assert.equal(result.sessionRef, "wrun_internal_1");
});


test("preserves a resumable session reference when the worker needs follow-up", async () => {
  process.env.BLUD_INTERNAL_KEY = "test-internal-secret";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: "failure",
        error: "browser_worker_waiting_for_human_input",
        message: "The worker needs an OTP.",
        sessionRef: "wrun_pending_1",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const result = await delegateBrowserTaskToBlud({ task: "Continue sign-in" });
  assert.equal(result.status, "failure");
  assert.equal(result.sessionRef, "wrun_pending_1");
});

test("returns offline status when Blud RPC endpoint is unreachable", async () => {
  process.env.BLUD_INTERNAL_KEY = "test-internal-secret";
  process.env.BLUD_INTERNAL_RPC_URL = "http://127.0.0.1:59999/api/nonexistent";
  const result = await delegateBrowserTaskToBlud({
    task: "Inspect the current page",
    timeoutMs: 1500,
  });
  assert.equal(result.status, "offline");
  assert.ok(result.observedAtUtc);
});
