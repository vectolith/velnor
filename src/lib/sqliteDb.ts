import fs from "fs";
import os from "os";
import path from "path";
import type { VelnorState } from "./store";

export function resolveWritableDataDir(): string {
  const localDir = path.join(process.cwd(), ".data");
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const testFile = path.join(localDir, ".write-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return localDir;
  } catch {
    const tmpDir = path.join(os.tmpdir(), "velnor-data");
    try {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
    } catch {
      // Ignore
    }
    return tmpDir;
  }
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

export function loadStateFromSqlite(): VelnorState | null {
  const db = getSqliteDb();
  if (!db) return null;
  try {
    const stmt = db.prepare("SELECT value FROM kv_state WHERE key = ?");
    const row = stmt.get("velnor_root_state") as { value?: string } | undefined;
    if (row && row.value) {
      return JSON.parse(row.value) as VelnorState;
    }
  } catch (err) {
    console.warn("SQLite read warning:", err);
  }
  return null;
}

export function saveStateToSqlite(state: VelnorState): boolean {
  const db = getSqliteDb();
  if (!db) return false;
  try {
    const now = new Date().toISOString();
    const upsertKv = db.prepare(`
      INSERT INTO kv_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upsertKv.run("velnor_root_state", JSON.stringify(state), now);

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
