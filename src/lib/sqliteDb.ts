import fs from "fs";
import os from "os";
import path from "path";
import type { VelnorState } from "./store";

function ensureWritable(dir: string): string | null {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Where state lives. An explicit VELNOR_DATA_DIR must win, otherwise SQLite would
 * write beside the code while the JSON profiles write to the mounted volume, and
 * both would claim to be the store. Only when the configured directory cannot be
 * written do we fall back to cwd/.data and then to a temp directory.
 */
export function resolveWritableDataDir(): string {
  const configured = (process.env.VELNOR_DATA_DIR || "").trim();
  if (configured) {
    const resolved = ensureWritable(path.resolve(configured));
    if (resolved) return resolved;
    if (process.env.NODE_ENV === "production") {
      throw new Error("Configured VELNOR_DATA_DIR is not writable; refusing ephemeral production storage.");
    }
    console.warn("VELNOR_DATA_DIR is not writable; falling back to a local data directory");
  }

  const localDir = ensureWritable(path.join(process.cwd(), ".data"));
  if (localDir) return localDir;
  if (process.env.NODE_ENV === "production") {
    throw new Error("No durable writable Velnor data directory is available in production.");
  }

  const tmpDir = path.join(os.tmpdir(), "velnor-data");
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // Ignore
  }
  return tmpDir;
}

let resolvedDataDir: string | null = null;
function getDataDir(): string {
  if (!resolvedDataDir) resolvedDataDir = resolveWritableDataDir();
  return resolvedDataDir;
}
function getSqlitePath(): string {
  return path.join(getDataDir(), "velnor.db");
}

let sqliteInstance: any = null;
let sqliteSupported: boolean | null = null;

function getSqliteDb() {
  if (sqliteSupported === false) return null;
  if (sqliteInstance) return sqliteInstance;

  try {
    // Use Node 22+ built-in node:sqlite module
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite");
    if (sqlite && sqlite.DatabaseSync) {
      const db = new sqlite.DatabaseSync(getSqlitePath());
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv_state_revisions (
          key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0)
        );
      `);
      const legacyVector = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vector_chunks'").get();
      const quarantinedVector = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_vector_chunks_quarantined'").get();
      if (legacyVector && !quarantinedVector) {
        db.exec("ALTER TABLE vector_chunks RENAME TO legacy_vector_chunks_quarantined");
      }
      sqliteInstance = db;
      sqliteSupported = true;
      return db;
    }
  } catch {
    sqliteSupported = false;
  }
  return null;
}

export function loadStateFromSqlite(key = "velnor_root_state"): VelnorState | null {
  const db = getSqliteDb();
  if (!db) return null;
  try {
    const stmt = db.prepare("SELECT value FROM kv_state WHERE key = ?");
    const row = stmt.get(key) as { value?: string } | undefined;
    if (row && row.value) return JSON.parse(row.value) as VelnorState;
  } catch (err) {
    console.warn("SQLite read warning:", err);
  }
  return null;
}

export function listStateKeysFromSqlite(): string[] {
  const db = getSqliteDb();
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT key FROM kv_state").all() as Array<{ key: string }>;
    return rows
      .map((row) => row.key === "velnor_root_state" ? "default" : row.key.startsWith("state:") ? row.key.slice(6) : "")
      .filter(Boolean);
  } catch (err) {
    console.warn("SQLite tenant listing warning:", err);
    return [];
  }
}

export class SqliteRevisionConflictError extends Error {
  constructor(readonly key: string, readonly expected: number, readonly actual: number) {
    super("SQLite tenant state revision conflict for " + key + ": expected " + expected + ", found " + actual + ".");
    this.name = "SqliteRevisionConflictError";
  }
}

export function getStateRevisionFromSqlite(key: string): number {
  const db = getSqliteDb();
  if (!db) throw new Error("SQLite is unavailable; durable revision checks cannot be guaranteed.");
  const row = db.prepare("SELECT revision FROM kv_state_revisions WHERE key = ?").get(key) as
    { revision?: number } | undefined;
  const revision = Number(row?.revision ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("SQLite tenant state revision is invalid for " + key + ".");
  }
  return revision;
}

/** Persist state and revision atomically; the mirror callback runs under the writer lock. */
export function saveStateToSqliteIfRevision(
  state: VelnorState,
  key: string,
  expectedRevision: number,
  updateRecoveryMirror?: () => void,
): number {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Expected SQLite revision must be a non-negative safe integer.");
  }
  const db = getSqliteDb();
  if (!db) throw new Error("SQLite is unavailable; refusing a non-atomic repository write.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT revision FROM kv_state_revisions WHERE key = ?").get(key) as
      { revision?: number } | undefined;
    const actual = Number(row?.revision ?? 0);
    if (actual !== expectedRevision) throw new SqliteRevisionConflictError(key, expectedRevision, actual);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO kv_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(state), now);
    db.prepare(`
      INSERT INTO kv_state_revisions (key, revision) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET revision = excluded.revision
    `).run(key, expectedRevision + 1);
    try { updateRecoveryMirror?.(); } catch (err) {
      console.warn("Could not update JSON recovery mirror for " + key + " after SQLite CAS write:", err);
    }
    db.exec("COMMIT");
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    return expectedRevision + 1;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

/** Legacy writes also advance the durable revision so repository CAS detects them. */
export function saveStateToSqlite(state: VelnorState, key = "velnor_root_state"): boolean {
  const db = getSqliteDb();
  if (!db) return false;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`
      INSERT INTO kv_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(state), new Date().toISOString());
    db.prepare(`
      INSERT INTO kv_state_revisions (key, revision) VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET revision = kv_state_revisions.revision + 1
    `).run(key);
    db.exec("COMMIT");
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    return true;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    console.warn("SQLite write warning:", err);
    return false;
  }
}

export function closeSqliteDb(): void {
  if (sqliteInstance) {
    try { sqliteInstance.exec?.("PRAGMA wal_checkpoint(TRUNCATE);"); } catch {}
    try { sqliteInstance.close?.(); } catch {}
    sqliteInstance = null;
  }
  resolvedDataDir = null;
}

export function getDatabaseEngineStatus(): {
  engine: "node:sqlite" | "JSON fallback";
  dbPath: string;
  writableDir: string;
} {
  const db = getSqliteDb();
  return {
    engine: db ? "node:sqlite" : "JSON fallback",
    dbPath: db ? getSqlitePath() : path.join(getDataDir(), "velnor-store.json"),
    writableDir: getDataDir(),
  };
}
