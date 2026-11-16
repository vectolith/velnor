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
  await withVelnorUser("scheduler-tenant-a", async () => {
    await createReminderAsync({ text: "tenant A reminder", dueAt: new Date(Date.now() - 1000).toISOString(), channel: "imessage", recipient: "" });
  });
  await withVelnorUser("scheduler-tenant-a", async () => {
    await createReminderAsync({ text: "future tenant A reminder", dueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), channel: "imessage", recipient: "" });
  });
  await withVelnorUser("scheduler-tenant-b", async () => {
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


test("overlapping scheduler runs claim a due reminder only once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-scheduler-claim-"));
  process.env.VELNOR_DATA_DIR = dir;
  const { withVelnorUser, getStore, resetStoreCache } = await import("../src/lib/store");
  const { createReminderAsync } = await import("../src/lib/tools/workspaceService");
  const { dispatchReminderNotification } = await import("../src/lib/scheduler");

  await withVelnorUser("scheduler-claim-tenant", async () => {
    await createReminderAsync({
      text: "dispatch exactly once across concurrent workers",
      dueAt: new Date(Date.now() - 1000).toISOString(),
      channel: "imessage",
      recipient: "",
    });
  });

  const [first, second] = await Promise.all([
    dispatchReminderNotification(),
    dispatchReminderNotification(),
  ]);
  const allResults = [...first, ...second];
  assert.equal(
    allResults.filter((item) => item.reminder.text === "dispatch exactly once across concurrent workers").length,
    1,
  );

  const state = await withVelnorUser("scheduler-claim-tenant", () => getStore());
  assert.equal(
    state.messages.filter((message) => message.text.includes("dispatch exactly once across concurrent workers")).length,
    1,
  );
  assert.equal(state.reminders.find((item) => item.text === "dispatch exactly once across concurrent workers")?.completed, true);

  resetStoreCache();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file handle release guard
  }
});


test("failed SMS reminders remain pending and retry after the claim is released", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-scheduler-sms-"));
  process.env.VELNOR_DATA_DIR = dir;
  const { withVelnorUser, getStore, saveStore, resetStoreCache } = await import("../src/lib/store");
  const { createReminderAsync } = await import("../src/lib/tools/workspaceService");
  const { dispatchReminderNotification } = await import("../src/lib/scheduler");
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) return new Response("provider unavailable", { status: 503 });
    return new Response(JSON.stringify({ sid: "SM-retry-accepted", status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await withVelnorUser("scheduler-sms-tenant", async () => {
      await createReminderAsync({
        text: "retry this SMS reminder",
        dueAt: new Date(Date.now() - 1000).toISOString(),
        channel: "sms",
        recipient: "+15550002",
      });
      const state = getStore();
      state.config.twilioAccountSid = "AC123";
      state.config.twilioAuthToken = "token";
      state.config.twilioFromNumber = "+15550001";
      saveStore(state);
    });

    const failed = await dispatchReminderNotification();
    assert.equal(failed.some((item) => item.reminder.text === "retry this SMS reminder"), false);
    const pending = await withVelnorUser("scheduler-sms-tenant", () => getStore());
    assert.equal(pending.reminders.find((item) => item.text === "retry this SMS reminder")?.completed, false);
    assert.equal(pending.messages.some((message) => message.text.includes("retry this SMS reminder")), false);

    const retried = await dispatchReminderNotification();
    const delivered = retried.find((item) => item.reminder.text === "retry this SMS reminder");
    assert.ok(delivered);
    assert.ok(delivered.deliveredVia.includes("twilio-sms"));
    const completed = await withVelnorUser("scheduler-sms-tenant", () => getStore());
    assert.equal(completed.reminders.find((item) => item.text === "retry this SMS reminder")?.completed, true);
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetStoreCache();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
