import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecipientAllowed,
  isRecipientAllowed,
  parseAllowlist,
  RecipientNotAllowedError,
} from "../src/lib/security/recipients";

test("an empty allowlist permits everything", () => {
  assert.deepEqual(parseAllowlist(undefined), []);
  assert.equal(isRecipientAllowed("anyone@example.com", []), true);
});

test("exact address and domain entries both match", () => {
  const list = parseAllowlist(" Chef@Example.com , @pluco.dev ,aishat@example.org");
  assert.deepEqual(list, ["chef@example.com", "@pluco.dev", "aishat@example.org"]);
  assert.equal(isRecipientAllowed("chef@example.com", list), true);
  assert.equal(isRecipientAllowed("CHEF@example.com", list), true);
  assert.equal(isRecipientAllowed("someone@pluco.dev", list), true);
  assert.equal(isRecipientAllowed("aishat@example.org", list), true);
});

test("addresses outside the allowlist are refused", () => {
  const list = parseAllowlist("ok@example.com,@pluco.dev");
  assert.equal(isRecipientAllowed("attacker@evil.test", list), false);
  assert.equal(isRecipientAllowed("not-an-address", list), false);
  assert.throws(() => assertRecipientAllowed("attacker@evil.test", list), RecipientNotAllowedError);
  assert.doesNotThrow(() => assertRecipientAllowed("ok@example.com", list));
});

test("a bare domain entry matches that domain", () => {
  const list = parseAllowlist("pluco.dev");
  assert.equal(isRecipientAllowed("dev@pluco.dev", list), true);
  assert.equal(isRecipientAllowed("dev@other.dev", list), false);
});
