import { emptyTaskLedger, parseTaskLedger, TASK_LEDGER_MAX_BYTES, type TaskLedger } from "./taskLedger";

export const TASK_LEDGER_STORAGE_KEY = "velnor.ide.tasks.v1";
export const TASK_LEDGER_RECOVERY_KEY = "velnor.ide.tasks.corrupt-backup.v1";

export type TaskLedgerStorage = Pick<Storage, "getItem" | "setItem">;
export type TaskLedgerRecoveryLoad = {
  ledger: TaskLedger;
  recoveryBackup: string | null;
  recoveryStored: boolean;
  notice: string;
};

function byteSize(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Load the browser-local ledger while preserving invalid raw data for export. */
export function loadTaskLedgerWithRecovery(storage: TaskLedgerStorage): TaskLedgerRecoveryLoad {
  let existingRecovery: string | null = null;
  try {
    existingRecovery = storage.getItem(TASK_LEDGER_RECOVERY_KEY);
  } catch {
    existingRecovery = null;
  }

  let raw: string | null;
  try {
    raw = storage.getItem(TASK_LEDGER_STORAGE_KEY);
  } catch {
    return {
      ledger: emptyTaskLedger(),
      recoveryBackup: existingRecovery,
      recoveryStored: existingRecovery !== null,
      notice: "Browser storage could not be read. The task ledger is shown empty; export any recovery copy before leaving.",
    };
  }

  if (raw === null) {
    return {
      ledger: emptyTaskLedger(),
      recoveryBackup: existingRecovery,
      recoveryStored: existingRecovery !== null,
      notice: existingRecovery ? "A separately saved recovery copy is available to export." : "",
    };
  }

  try {
    return {
      ledger: parseTaskLedger(raw),
      recoveryBackup: existingRecovery,
      recoveryStored: existingRecovery !== null,
      notice: existingRecovery ? "A separately saved recovery copy is available to export." : "",
    };
  } catch {
    let stored = false;
    if (existingRecovery === null && byteSize(raw) <= TASK_LEDGER_MAX_BYTES) {
      try {
        storage.setItem(TASK_LEDGER_RECOVERY_KEY, raw);
        stored = true;
      } catch {
        stored = false;
      }
    }
    return {
      ledger: emptyTaskLedger(),
      recoveryBackup: raw,
      recoveryStored: stored,
      notice: stored
        ? "Saved task data was invalid. A recovery copy was preserved separately; export it before replacing the ledger."
        : "Saved task data was invalid. A recovery copy is available for export; export it before overwriting or leaving the page.",
    };
  }
}
