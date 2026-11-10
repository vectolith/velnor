import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression test for the leak that shipped once already: saveStore() sealed the
 * JSON copy but handed the raw state to saveStateToSqlite(), so provider keys sat
 * in plaintext inside velnor.db. The environment has to be set before store.ts is
 * imported because it resolves its data directory at module load.
 */
const SENTINEL = "sk-plaintext-probe-0123456789abcdef";

function sqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite");
    return Boolean(sqlite && sqlite.DatabaseSync);
  } catch {
    return false;
  }
}

test("provider keys never reach SQLite, or the JSON store, in plaintext", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-seal-"));
  const env = process.env as Record<string, string | undefined>;
  env.VELNOR_DATA_DIR = dir;
  env.VELNOR_SECRET_KEY = "0123456789abcdef0123456789abcdef";

  const store = await import("../src/lib/store");
  const state = store.getStore();
  state.config.geminiApiKey = SENTINEL;
  store.saveStore(state);

  const usersDir = path.join(dir, "users");
  const jsonFile = fs.readdirSync(usersDir).find((f) => f.endsWith(".json"));
  assert.ok(jsonFile, "no JSON state file was written");
  const json = fs.readFileSync(path.join(usersDir, jsonFile), "utf8");
  assert.ok(!json.includes(SENTINEL), "JSON store wrote the provider key in plaintext");
  assert.ok(json.includes("v1:"), "JSON store did not seal the credential");

  // The database must live on the configured volume, not beside the code, or a
  // container restart silently drops every profile while the JSON store survives.
  const dbFile = path.join(dir, "velnor.db");
  if (sqliteAvailable()) {
    assert.ok(fs.existsSync(dbFile), `SQLite ignored VELNOR_DATA_DIR (nothing at ${dbFile})`);
    const raw = fs.readFileSync(dbFile, "latin1");
    assert.ok(!raw.includes(SENTINEL), "SQLite store wrote the provider key in plaintext");
  }

  // The key must still be usable: reloading the profile must return the real value.
  const reloaded = store.loadUserState(store.sanitizeUserId("default"));
  assert.equal(reloaded.config.geminiApiKey, SENTINEL, "sealed key did not decrypt on load");
  fs.rmSync(dir, { recursive: true, force: true });
});
