import assert from "node:assert/strict";
import test from "node:test";
import { coerceState, migrateState, STATE_SCHEMA_VERSION, validateState } from "../src/lib/security/stateSchema";

test("a v1 payload is migrated and stamped with the current version", () => {
  const { value, applied } = migrateState({ schemaVersion: 1, config: { channel: "imessage", geminiModel: "x" }, messages: [] });
  assert.deepEqual(applied, [2]);
  assert.equal(value.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(value.config, { geminiModel: "x" });
});

test("migration is idempotent", () => {
  const once = migrateState({ config: { channel: "slack" } }).value;
  const twice = migrateState(once).value;
  assert.deepEqual(twice, once);
});

test("validation reports non-array collections and a missing version", () => {
  const report = validateState({ messages: "nope", schemaVersion: undefined });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.includes("messages")));
  assert.ok(report.issues.some((issue) => issue.includes("schemaVersion")));
});

test("coercion repairs a corrupt state instead of failing the profile", () => {
  const { value, issues } = coerceState({ messages: "nope", config: 42, reminders: [] });
  assert.deepEqual(value.messages, []);
  assert.deepEqual(value.config, {});
  assert.equal(issues.length, 2);
});

test("non-object payloads are rejected rather than trusted", () => {
  assert.equal(validateState(null).ok, false);
  assert.deepEqual(coerceState("garbage").value, {});
});
