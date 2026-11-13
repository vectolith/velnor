import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { authorizeChatTenant, DEFAULT_TENANT } from "../src/lib/security/tenant";

const secret = "test-tenant-token-secret-with-at-least-32-bytes";
process.env.VELNOR_TENANT_TOKEN_SECRET = secret;

function token(sub: string, overrides: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({
    iss: "velnor-auth",
    aud: "velnor-api",
    sub,
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...overrides,
  });
  const signature = crypto.createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
  return "Bearer " + header + "." + payload + "." + signature;
}

test("missing authorization is denied", () => {
  const decision = authorizeChatTenant(undefined, [DEFAULT_TENANT]);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
});

test("the reserved owner identity maps to the legacy default partition", () => {
  const decision = authorizeChatTenant(token("owner"), [DEFAULT_TENANT]);
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, "default");
});

test("a valid signed identity selects its provisioned tenant", () => {
  const decision = authorizeChatTenant(token("tenant-123"), [DEFAULT_TENANT, "tenant-123"]);
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, "tenant-123");
});

test("internal storage key prefixes cannot be used as external tenant subjects", () => {
  assert.equal(authorizeChatTenant(token("v2_tenant-123"), [DEFAULT_TENANT]).ok, false);
  assert.equal(authorizeChatTenant(token("v2h_" + "a".repeat(64)), [DEFAULT_TENANT]).ok, false);
});

test("a trusted gateway can map an authenticated subject to an existing provider tenant", () => {
  const decision = authorizeChatTenant(
    token("gateway-user-uuid", { tenant_id: "v2_tenant-123" }),
    [DEFAULT_TENANT, "tenant-123"]
  );
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, "v2_tenant-123");
});

test("caller-controlled tenant headers are not accepted as tokens", () => {
  const decision = authorizeChatTenant("tenant-123", [DEFAULT_TENANT, "tenant-123"]);
  assert.equal(decision.ok, false);
});

test("unknown signed identities are refused", () => {
  const decision = authorizeChatTenant(token("unknown-tenant"), [DEFAULT_TENANT]);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
});

test("invalid signatures are refused", () => {
  const valid = token("tenant-123", {});
  const tampered = valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");
  assert.equal(authorizeChatTenant(tampered, [DEFAULT_TENANT, "tenant-123"]).ok, false);
});

test("expired tokens are refused", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(authorizeChatTenant(token("tenant-123", { iat: now - 600, exp: now - 1 }), [DEFAULT_TENANT, "tenant-123"]).ok, false);
});

test("tokens with excessive lifetime are refused", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(authorizeChatTenant(token("tenant-123", { exp: now + 3600 }), [DEFAULT_TENANT, "tenant-123"]).ok, false);
});

test("only HS256 JWT tokens with the expected issuer and audience are accepted", () => {
  assert.equal(authorizeChatTenant(token("tenant-123", { iss: "attacker" }), [DEFAULT_TENANT, "tenant-123"]).ok, false);
  assert.equal(authorizeChatTenant(token("tenant-123", { aud: "other-api" }), [DEFAULT_TENANT, "tenant-123"]).ok, false);
});
