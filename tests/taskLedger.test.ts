import { test } from "node:test";
import assert from "node:assert/strict";
import { addLedgerTask, emptyTaskLedger, parseTaskLedger, replaceLedgerTask, TASK_LEDGER_LIMIT } from "../src/lib/ide/taskLedger";
import { transitionTask } from "../src/lib/ide/tasks";

test("ledger creates tasks and rejects duplicate ids", () => {
  const ledger = addLedgerTask(emptyTaskLedger(), "t1", "First task", "a");
  assert.equal(ledger.tasks[0].status, "queued");
  assert.throws(() => addLedgerTask(ledger, "t1", "Duplicate", "b"), /already exists/);
});

test("ledger schema rejects corrupted and unsupported payloads", () => {
  assert.throws(() => parseTaskLedger("not-json"));
  assert.throws(() => parseTaskLedger(JSON.stringify({ schemaVersion: 2, tasks: [] })), /Unsupported/);
  const duplicate = { schemaVersion: 1, tasks: [{ id: "x", title: "a", status: "queued", createdAt: "a", updatedAt: "a", events: [] }, { id: "x", title: "b", status: "queued", createdAt: "a", updatedAt: "a", events: [] }] };
  assert.throws(() => parseTaskLedger(JSON.stringify(duplicate)), /unique/);
});

test("ledger limits retained tasks and replaces an existing task", () => {
  let ledger = emptyTaskLedger();
  for (let i = 0; i < TASK_LEDGER_LIMIT + 5; i++) ledger = addLedgerTask(ledger, "t" + i, "Task " + i, String(i));
  assert.equal(ledger.tasks.length, TASK_LEDGER_LIMIT);
  assert.equal(ledger.tasks[0].id, "t" + (TASK_LEDGER_LIMIT + 4));
  const changed = transitionTask(ledger.tasks[0], "planning", "later");
  const next = replaceLedgerTask(ledger, changed);
  assert.equal(next.tasks[0].status, "planning");
  assert.throws(() => replaceLedgerTask(next, { ...changed, id: "missing" }), /not found/);
});

test("ledger validates task events and evidence shape", () => {
  const bad = { schemaVersion: 1, tasks: [{ id: "x", title: "a", status: "queued", createdAt: "a", updatedAt: "a", events: [{ type: "validation", at: "a", detail: "bad", evidence: { at: "a", checks: [{ name: 3, passed: true }] } }] }] };
  assert.throws(() => parseTaskLedger(JSON.stringify(bad)), /evidence/);
});
