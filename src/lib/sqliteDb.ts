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
    console.warn(`VELNOR_DATA_DIR=${configured} is not writable; falling back to a local data directory`);
  }

  const localDir = ensureWritable(path.join(process.cwd(), ".data"));
  if (localDir) return localDir;

  const tmpDir = path.join(os.tmpdir(), "velnor-data");
  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    // Ignore
  }
  return tmpDir;
}

const DATA_DIR = resolveWritableDataDir();
const SQLITE_PATH = path.join(DATA_DIR, "velnor.db");

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
      const db = new sqlite.DatabaseSync(SQLITE_PATH);
      db.exec(`
        CREATE TABLE IF NOT EXISTS kv_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vector_chunks (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL,
          doc_name TEXT NOT NULL,
          content TEXT NOT NULL,
          tokens_json TEXT NOT NULL,
          embedding_json TEXT
        );
      `);
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

    // Sync vector_chunks table for structured inspection
    const upsertChunk = db.prepare(`
      INSERT INTO vector_chunks (id, doc_id, doc_name, content, tokens_json, embedding_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        tokens_json = excluded.tokens_json,
        embedding_json = excluded.embedding_json
    `);
    for (const chunk of state.documentChunks.slice(0, 500)) {
      upsertChunk.run(
        chunk.id,
        chunk.docId,
        chunk.docName,
        chunk.content,
        JSON.stringify(chunk.tokens),
        chunk.embedding ? JSON.stringify(chunk.embedding) : null
      );
    }
    return true;
  } catch (err) {
    console.warn("SQLite write warning:", err);
    return false;
  }
}

export function getDatabaseEngineStatus(): {
  engine: "node:sqlite (SQLite3 + HNSW Memory)" | "JSON + In-Memory HNSW";
  dbPath: string;
  writableDir: string;
} {
  const db = getSqliteDb();
  return {
    engine: db ? "node:sqlite (SQLite3 + HNSW Memory)" : "JSON + In-Memory HNSW",
    dbPath: db ? SQLITE_PATH : path.join(DATA_DIR, "velnor-store.json"),
    writableDir: DATA_DIR,
  };
}
