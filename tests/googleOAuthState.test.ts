import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleOAuthState, verifyGoogleOAuthState } from "../src/lib/security/googleOAuthState";

process.env.VELNOR_TENANT_TOKEN_SECRET ||= "test-tenant-token-secret-with-at-least-32-bytes";

test("Google OAuth state is signed, tenant-bound, and time-limited", () => {
  const state = createGoogleOAuthState("slack:TEAM123:U123", "n".repeat(48));
  const payload = verifyGoogleOAuthState(state);
  assert.equal(payload?.tenantId, "slack:TEAM123:U123");
  assert.equal(payload?.nonce, "n".repeat(48));
  assert.equal(verifyGoogleOAuthState(state + "x"), null);
});

test("expired Google OAuth state is rejected", () => {
  const state = createGoogleOAuthState("tenant-123", "n".repeat(48), -1);
  assert.equal(verifyGoogleOAuthState(state), null);
});

test("Google OAuth state refuses an invalid tenant binding", () => {
  assert.throws(() => createGoogleOAuthState("https://attacker.example", "n".repeat(48)), /tenant binding/);
});
