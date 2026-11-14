import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VELNOR_SECRET_KEY ||= "test-secret-key-for-store-suite-32-bytes";

test("reminder dispatch traverses tenant partitions without mixing their state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-scheduler-"));
  process.env.VELNOR_DATA_DIR = dir;
  const { withVelnorUser, getStore, resetStoreCache } = await import("../src/lib/store");
  const { createReminderAsync } = await import("../src/lib/tools/workspaceService");
  const { dispatchReminderNotification } = await import("../src/lib/scheduler");
  await withVelnorUser("scheduler-tenant-a", () => {
    await createReminderAsync({ text: "tenant A reminder", dueAt: new Date(Date.now() - 1000).toISOString(), channel: "imessage", recipient: "" });
  });
  await withVelnorUser("scheduler-tenant-a", () => {
    await createReminderAsync({ text: "future tenant A reminder", dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), channel: "imessage", recipient: "" });
  });
  await withVelnorUser("scheduler-tenant-b", () => {
    await createReminderAsync({ text: "tenant B reminder", dueAt: new Date(Date.now() - 1000).toISOString(), channel: "imessage", recipient: "" });
  });

  const dispatched = await dispatchReminderNotification();
  assert.ok(dispatched.some((item) => item.reminder.text === "tenant A reminder"));
  assert.ok(dispatched.some((item) => item.reminder.text === "tenant B reminder"));

  const a = await withVelnorUser("scheduler-tenant-a", () => getStore().reminders);
  const b = await withVelnorUser("scheduler-tenant-b", () => getStore().reminders);
  assert.equal(a.find((item) => item.text === "tenant A reminder")?.completed, true);
  assert.equal(b.find((item) => item.text === "tenant B reminder")?.completed, true);
  assert.equal(a.some((item) => item.text === "tenant B reminder"), false);
  assert.equal(b.some((item) => item.text === "tenant A reminder"), false);
  assert.equal(a.find((item) => item.text === "future tenant A reminder")?.completed, false);
  assert.equal(dispatched.some((item) => item.reminder.text === "future tenant A reminder"), false);
  resetStoreCache();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file handle release guard
  }
});
