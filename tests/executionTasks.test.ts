import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeSqliteDb } from "../src/lib/sqliteDb";
import {
  assertExecutionTaskActive, createExecutionTask, finishExecutionTask,
  getExecutionTask, listExecutionTasks, requestExecutionTaskCancellation, startExecutionTask,
} from "../src/lib/tasks/taskStore";

test("execution tasks persist lifecycle, cancellation and tenant-scoped history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "velnor-tasks-"));
  const previous = process.env.VELNOR_DATA_DIR;
  process.env.VELNOR_DATA_DIR = directory;
  closeSqliteDb();
  try {
    const task = createExecutionTask({ tenantId: "tenant_a", channel: "discord", userHandle: "user_1" });
    assert.equal(task.status, "queued");
    startExecutionTask("tenant_a", task.id);
    assert.equal(getExecutionTask("tenant_a", task.id)?.status, "running");
    assert.equal(requestExecutionTaskCancellation("tenant_a", task.id), true);
    assert.throws(() => assertExecutionTaskActive("tenant_a", task.id), /cancelled/);
    finishExecutionTask("tenant_a", task.id, "failed", "ignored after cancellation");
    assert.equal(getExecutionTask("tenant_a", task.id)?.status, "cancelled");
    assert.equal(listExecutionTasks("tenant_a").length, 1);
    assert.equal(listExecutionTasks("tenant_b").length, 0);
    assert.equal(requestExecutionTaskCancellation("tenant_a", task.id), false);

    const emailTask = createExecutionTask({
      tenantId: "tenant_a", channel: "imessage", userHandle: "alex@icloud.com",
    });
    const phoneTask = createExecutionTask({
      tenantId: "tenant_a", channel: "imessage", userHandle: "+2348012345678",
    });
    assert.equal(getExecutionTask("tenant_a", emailTask.id)?.userHandle, "alex@icloud.com");
    assert.equal(getExecutionTask("tenant_a", phoneTask.id)?.userHandle, "+2348012345678");
    assert.equal(getExecutionTask("tenant_b", emailTask.id), null);
  } finally {
    closeSqliteDb();
    if (previous === undefined) delete process.env.VELNOR_DATA_DIR;
    else process.env.VELNOR_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
