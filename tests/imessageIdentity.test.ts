import assert from "node:assert/strict";
import test from "node:test";
import { getLoopMessageRecipient, isLoopMessagePayload, normalizeImessageIdentity } from "../src/lib/channels/imessageIdentity";

test("iMessage accepts and canonicalizes Apple ID email identities", () => {
  assert.equal(normalizeImessageIdentity("  Alex.Example@iCloud.com  "), "alex.example@icloud.com");
  assert.equal(getLoopMessageRecipient({ email: "Alex@Example.com" }), "alex@example.com");
  assert.equal(isLoopMessagePayload({ from_email: "alex@example.com" }), true);
});

test("iMessage rejects malformed email identities but preserves phone handles", () => {
  assert.equal(normalizeImessageIdentity("not-an-email@"), null);
  assert.equal(normalizeImessageIdentity("+15551234567"), "+15551234567");
  assert.equal(isLoopMessagePayload({ number: "+15551234567" }), false);
});
