import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type StoreModule = typeof import("../src/lib/store");
let store: StoreModule;
let testRoot = "";

test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-store-"));
  testRoot = tmp;
  process.chdir(tmp);
  store = await import("../src/lib/store");
});

process.env.VELNOR_SECRET_KEY ||= "test-secret-key-for-store-suite-32-bytes";

test("tenants do not see each other's data", async () => {
  await store.withVelnorUser("imessage:+15550001", async () => {
    const s = store.getStore();
    s.memories.push({ id: "m1", category: "preference", fact: "likes tea", createdAt: new Date().toISOString() });
    store.saveStore(s);
  });

  const other = await store.withVelnorUser("imessage:+15550002", async () => store.getStore());
  assert.equal(other.memories.length, 0);

  const mine = await store.withVelnorUser("imessage:+15550001", async () => store.getStore());
  assert.equal(mine.memories.length, 1);
});

test("state survives a cache reset (persisted per user)", async () => {
  store.resetStoreCache();
  const reloaded = await store.withVelnorUser("imessage:+15550001", async () => store.getStore());
  assert.equal(reloaded.memories[0].fact, "likes tea");
});

test("sealed provider credentials hydrate correctly from SQLite", async (t) => {
  const { getDatabaseEngineStatus } = await import("../src/lib/sqliteDb");
  if (!getDatabaseEngineStatus().engine.startsWith("node:sqlite")) {
    t.skip("Node built-in SQLite is unavailable in this runtime");
    return;
  }

  const previousKey = process.env.VELNOR_SECRET_KEY;
  process.env.VELNOR_SECRET_KEY = "store-test-key-with-at-least-16-characters";
  try {
    await store.withVelnorUser("imessage:credential-hydration", async () => {
      const state = store.getStore();
      state.config.openaiApiKey = "sk-test-credential";
      store.saveStore(state);
    });

    store.resetStoreCache();
    await store.withVelnorUser("imessage:credential-hydration", async () => {
      assert.equal(store.getStore().config.openaiApiKey, "sk-test-credential");
    });
  } finally {
    if (previousKey === undefined) delete process.env.VELNOR_SECRET_KEY;
    else process.env.VELNOR_SECRET_KEY = previousKey;
  }
});

test("SQLite tenant records remain discoverable without a JSON mirror", async (t) => {
  const { getDatabaseEngineStatus } = await import("../src/lib/sqliteDb");
  if (!getDatabaseEngineStatus().engine.startsWith("node:sqlite")) {
    t.skip("Node built-in SQLite is unavailable in this runtime");
    return;
  }
  const rawId = "sqlite-only-tenant";
  const id = store.sanitizeUserId(rawId);
  await store.withVelnorUser(rawId, async () => {
    store.getStore().memories.push({ id: "sqlite-only", category: "work", fact: "persisted in SQLite", createdAt: new Date().toISOString() });
    store.saveStore(store.getStore());
  });
  fs.unlinkSync(path.join(testRoot, ".data", "users", id + ".json"));
  store.resetStoreCache();
  assert.ok(store.listUserIds().includes(id));
  const restored = await store.withVelnorUser(rawId, async () => store.getStore());
  assert.equal(restored.memories[0].fact, "persisted in SQLite");
});

test("legacy tenant JSON is migrated into the collision-resistant key format", async () => {
  const rawId = "imessage:+15550003";
  const legacyId = "imessage_+15550003";
  const state = await store.withVelnorUser("legacy-state-template", async () => store.getStore());
  state.memories.push({ id: "legacy-memory", category: "work", fact: "preserved during migration", createdAt: new Date().toISOString() });
  fs.mkdirSync(path.join(testRoot, ".data", "users"), { recursive: true });
  fs.writeFileSync(path.join(testRoot, ".data", "users", legacyId + ".json"), JSON.stringify(state));
  store.resetStoreCache();

  const migrated = await store.withVelnorUser(rawId, async () => store.getStore());
  assert.equal(migrated.memories[0].fact, "preserved during migration");
  assert.ok(fs.existsSync(path.join(testRoot, ".data", "users", store.sanitizeUserId(rawId) + ".json")));
});

test("user ids are sanitised for filesystem use", () => {
  const key = store.sanitizeUserId("iMessage:+1 (555) 019-2834");
  assert.match(key, /^v2_/);
  assert.notEqual(key, store.sanitizeUserId("imessage_+1__555__019-2834"));
  assert.equal(store.sanitizeUserId(key), key);
  assert.equal(store.sanitizeUserId(""), "default");
});

test("legacy plaintext credentials in SQLite are resealed during hydration", async (t) => {
  const { getDatabaseEngineStatus, saveStateToSqlite } = await import("../src/lib/sqliteDb");
  if (!getDatabaseEngineStatus().engine.startsWith("node:sqlite")) {
    t.skip("Node built-in SQLite is unavailable in this runtime");
    return;
  }

  const rawId = "sqlite-legacy-plaintext";
  const id = store.sanitizeUserId(rawId);
  const state = await store.withVelnorUser(rawId, async () => store.getStore());
  state.config.loopMessageAuthKey = "legacy-loopmessage-auth-key";
  saveStateToSqlite(state, "state:" + id);
  const jsonPath = path.join(testRoot, ".data", "users", id + ".json");
  if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);

  store.resetStoreCache();
  const restored = await store.withVelnorUser(rawId, async () => store.getStore());
  assert.equal(restored.config.loopMessageAuthKey, "legacy-loopmessage-auth-key");

  assert.ok(fs.existsSync(jsonPath), "hydration did not rewrite the JSON recovery mirror");
  const persisted = fs.readFileSync(jsonPath, "utf8");
  assert.ok(!persisted.includes("legacy-loopmessage-auth-key"), "legacy secret remained plaintext on disk");
  assert.match(persisted, /v2:/, "legacy secret was not resealed with the active key format");
  const sqliteBytes = fs.readFileSync(path.join(testRoot, ".data", "velnor.db"), "latin1");
  assert.ok(!sqliteBytes.includes("legacy-loopmessage-auth-key"), "SQLite still contains the legacy plaintext secret");
});

test("tenant-only scope establishes identity without loading or persisting the Node store", async () => {
  const rawId = "scope-only-tenant";
  const id = store.sanitizeUserId(rawId);
  await store.withVelnorTenantScope(rawId, async () => {
    assert.equal(store.currentUserId(), id);
    assert.equal(store.getStore().memories.length, 0);
    await store.withVelnorTenantScope(rawId, () => {
      assert.equal(store.currentUserId(), id);
      store.getStore().memories.push({
        id: "scope-memory",
        category: "preference",
        fact: "in-scope only",
        createdAt: new Date().toISOString(),
      });
    });
    assert.equal(store.getStore().memories[0]?.fact, "in-scope only");
  });
  assert.equal(store.listUserIds().includes(id), false);
  await assert.rejects(store.withVelnorTenantScope("", () => undefined), /tenant identity is required/);
});
