import assert from "node:assert/strict";
import test from "node:test";
import { withVelnorUser, getStore } from "../src/lib/store";
import { createReminder } from "../src/lib/tools/workspaceService";
import { dispatchReminderNotification } from "../src/lib/scheduler";

test("reminder dispatch traverses tenant partitions without mixing their state", async () => {
  await withVelnorUser("scheduler-tenant-a", () => {
    createReminder({ text: "tenant A reminder", dueAt: "now", channel: "imessage", recipient: "" });
  });
  await withVelnorUser("scheduler-tenant-b", () => {
    createReminder({ text: "tenant B reminder", dueAt: "now", channel: "imessage", recipient: "" });
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
});
