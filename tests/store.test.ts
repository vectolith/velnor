import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type StoreModule = typeof import("../src/lib/store");
let store: StoreModule;

test.before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-store-"));
  process.chdir(tmp);
  store = await import("../src/lib/store");
});

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

test("user ids are sanitised for filesystem use", () => {
  assert.equal(store.sanitizeUserId("iMessage:+1 (555) 019-2834"), "imessage_+1__555__019-2834");
  assert.equal(store.sanitizeUserId(""), "default");
});
