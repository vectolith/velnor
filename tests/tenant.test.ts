import assert from "node:assert/strict";
import test from "node:test";
import { authorizeChatTenant, DEFAULT_TENANT } from "../src/lib/security/tenant";

test("no header resolves to the default tenant", () => {
  const decision = authorizeChatTenant(undefined, ["owner", "imessage-2345"]);
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, DEFAULT_TENANT);
});

test("an existing profile can be addressed", () => {
  const decision = authorizeChatTenant("imessage-2345", ["owner", "imessage-2345"]);
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, "imessage-2345");
});

test("an unknown tenant is refused instead of created", () => {
  const decision = authorizeChatTenant("../../etc/passwd", ["owner"]);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403);
  assert.match(String(decision.error), /Unknown tenant/);
});

test("control characters are sanitised before comparison", () => {
  const decision = authorizeChatTenant("OWNER\n", ["owner"]);
  assert.equal(decision.ok, true);
  assert.equal(decision.userId, "owner");
});
