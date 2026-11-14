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
  // Resolve storage only when a request actually accesses persistence. Next.js
  // evaluates route modules during `next build`, where production volumes do
  // not exist and must not be required.
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
      `);
      // The former global vector_chunks table had no tenant ownership column.
      // Quarantine it instead of deleting it: it is no longer queried, but
      // operators retain a recoverable copy for a controlled tenant-aware import.
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
    if (row && row.value) {
      return JSON.parse(row.value) as VelnorState;
    }
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

export function saveStateToSqlite(state: VelnorState, key = "velnor_root_state"): boolean {
  const db = getSqliteDb();
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    const upsertKv = db.prepare(`
      INSERT INTO kv_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upsertKv.run(key, JSON.stringify(state), now);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}

    return true;
  } catch (err) {
    console.warn("SQLite write warning:", err);
    return false;
  }
}

export function closeSqliteDb(): void {
  if (sqliteInstance) {
    try {
      sqliteInstance.exec?.("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // Ignore checkpoint error
    }
    try {
      sqliteInstance.close?.();
    } catch {
      // Ignore cleanup error
    }
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
