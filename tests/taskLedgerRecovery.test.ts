import test from "node:test";
import assert from "node:assert/strict";
import { emptyTaskLedger, TASK_LEDGER_MAX_BYTES } from "../src/lib/ide/taskLedger";
import { loadTaskLedgerWithRecovery, TASK_LEDGER_RECOVERY_KEY, TASK_LEDGER_STORAGE_KEY } from "../src/lib/ide/taskLedgerRecovery";

function memoryStorage(seed: Record<string, string> = {}, failSet = false, failGet = false) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem(key: string) { if (failGet) throw new Error("storage unavailable"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (failSet) throw new Error("storage unavailable"); values.set(key, value); },
  };
}

test("invalid ledger is preserved separately when recovery storage is available", () => {
  const storage = memoryStorage({ [TASK_LEDGER_STORAGE_KEY]: "{invalid" });
  const result = loadTaskLedgerWithRecovery(storage);
  assert.deepEqual(result.ledger, emptyTaskLedger());
  assert.equal(result.recoveryBackup, "{invalid");
  assert.equal(result.recoveryStored, true);
  assert.equal(storage.values.get(TASK_LEDGER_RECOVERY_KEY), "{invalid");
  assert.match(result.notice, /preserved separately/i);
});

test("does not overwrite an existing recovery copy and exposes the current corrupt data in memory", () => {
  const storage = memoryStorage({ [TASK_LEDGER_STORAGE_KEY]: "new-corrupt", [TASK_LEDGER_RECOVERY_KEY]: "older-backup" });
  const result = loadTaskLedgerWithRecovery(storage);
  assert.equal(result.recoveryBackup, "new-corrupt");
  assert.equal(result.recoveryStored, false);
  assert.equal(storage.values.get(TASK_LEDGER_RECOVERY_KEY), "older-backup");
  assert.match(result.notice, /export it before overwriting/i);
});

test("oversized corrupt data remains exportable in memory without another storage write", () => {
  const raw = "x".repeat(TASK_LEDGER_MAX_BYTES + 1);
  const storage = memoryStorage({ [TASK_LEDGER_STORAGE_KEY]: raw });
  const result = loadTaskLedgerWithRecovery(storage);
  assert.equal(result.recoveryBackup, raw);
  assert.equal(result.recoveryStored, false);
  assert.equal(storage.values.has(TASK_LEDGER_RECOVERY_KEY), false);
});

test("storage write failure leaves a recovery copy available in memory", () => {
  const storage = memoryStorage({ [TASK_LEDGER_STORAGE_KEY]: "{invalid" }, true);
  const result = loadTaskLedgerWithRecovery(storage);
  assert.equal(result.recoveryBackup, "{invalid");
  assert.equal(result.recoveryStored, false);
  assert.match(result.notice, /export it before overwriting/i);
});

test("valid ledger loads and an earlier recovery copy remains exportable", () => {
  const raw = JSON.stringify(emptyTaskLedger());
  const storage = memoryStorage({ [TASK_LEDGER_STORAGE_KEY]: raw, [TASK_LEDGER_RECOVERY_KEY]: "older-backup" });
  const result = loadTaskLedgerWithRecovery(storage);
  assert.deepEqual(result.ledger, emptyTaskLedger());
  assert.equal(result.recoveryBackup, "older-backup");
  assert.equal(result.recoveryStored, true);
});

test("storage read failure returns a clean ledger with an explicit notice", () => {
  const result = loadTaskLedgerWithRecovery(memoryStorage({}, false, true));
  assert.deepEqual(result.ledger, emptyTaskLedger());
  assert.equal(result.recoveryBackup, null);
  assert.match(result.notice, /could not be read/i);
});
