import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleOAuthState, verifyGoogleOAuthState } from "../src/lib/security/googleOAuthState";
import { createGoogleOAuthStateAsync, verifyGoogleOAuthStateAsync } from "../src/lib/security/googleOAuthStateWebCrypto";

const secret = "test-tenant-token-secret-with-at-least-32-bytes";

test("Workers Web Crypto Google OAuth state interoperates with the Node HMAC format", async () => {
  const nodeState = createGoogleOAuthState("slack:TEAM123:U123", "n".repeat(48));
  const webPayload = await verifyGoogleOAuthStateAsync(nodeState, secret);
  assert.equal(webPayload?.tenantId, "slack:TEAM123:U123");
  assert.equal(webPayload?.nonce, "n".repeat(48));
  const webState = await createGoogleOAuthStateAsync("tenant-123", "x".repeat(48), secret);
  assert.equal(verifyGoogleOAuthState(webState)?.tenantId, "tenant-123");
  assert.equal(await verifyGoogleOAuthStateAsync(webState + "x", secret), null);
});

test("Workers Web Crypto OAuth state rejects wrong secrets and invalid bindings", async () => {
  const valid = await createGoogleOAuthStateAsync("tenant-123", "n".repeat(48), secret);
  assert.equal(await verifyGoogleOAuthStateAsync(valid, secret + "-wrong"), null);
  await assert.rejects(createGoogleOAuthStateAsync("https://attacker.example", "n".repeat(48), secret), /tenant binding/);
});
