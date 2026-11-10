import assert from "node:assert/strict";
import test from "node:test";
import { BoundedTtlCache, inboundKey } from "../src/lib/security/idempotency";

test("a key is accepted once and rejected while it is fresh", () => {
  const cache = new BoundedTtlCache(1000);
  const now = 1_000_000;
  assert.equal(cache.seen("a", now), true);
  assert.equal(cache.seen("a", now + 10), false);
});

test("a key is accepted again after the TTL", () => {
  const cache = new BoundedTtlCache(1000);
  const now = 1_000_000;
  assert.equal(cache.seen("a", now), true);
  assert.equal(cache.seen("a", now + 1500), true);
});

test("the cache stays bounded", () => {
  const cache = new BoundedTtlCache(10_000, 3);
  const now = 1_000_000;
  for (let i = 0; i < 10; i += 1) cache.seen(`key-${i}`, now);
  assert.ok(cache.size <= 3, `size should be capped, got ${cache.size}`);
});

test("inboundKey ignores empty parts and is stable", () => {
  assert.equal(inboundKey(["twilio", undefined, "SM123"]), "twilio|SM123");
  assert.equal(inboundKey([undefined, ""]), "");
});
