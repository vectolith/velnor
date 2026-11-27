import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask, transitionTask, completeTask, addTaskNote, canTransitionTask } from "../src/lib/ide/tasks";

test("task creation records initial event and queued state", () => {
  const task = createTask("t1", "Implement feature", "2026-01-01T00:00:00Z");
  assert.equal(task.status, "queued");
  assert.equal(task.events.length, 1);
  assert.equal(task.events[0].type, "created");
});

test("task workflow allows planning, execution, validation and completion", () => {
  let task = createTask("t2", "Build", "a");
  task = transitionTask(task, "planning", "b");
  task = transitionTask(task, "executing", "c");
  task = transitionTask(task, "validating", "d");
  task = completeTask(task, { at: "e", checks: [{ name: "unit tests", passed: true }, { name: "typecheck", passed: true }], summary: "All acceptance checks passed" });
  assert.equal(task.status, "completed");
  assert.equal(task.events.length, 5);
});

test("invalid transitions and terminal completion are rejected", () => {
  const task = createTask("t3", "Build", "a");
  assert.throws(() => transitionTask(task, "completed", "b"), /Invalid task transition/);
  const done = transitionTask(transitionTask(transitionTask(task, "planning", "b"), "executing", "c"), "validating", "d");
  const completed = completeTask(done, { at: "e", checks: [{ name: "tests", passed: true }] });
  assert.throws(() => transitionTask(completed, "executing", "f"), /Invalid task transition/);
});

test("blocked work can resume and cancellation is supported", () => {
  let task = createTask("t4", "Build", "a");
  task = transitionTask(task, "planning", "b");
  task = transitionTask(task, "blocked", "c", "Missing dependency");
  task = transitionTask(task, "planning", "d", "Resume after dependency");
  task = transitionTask(task, "cancelled", "e");
  assert.equal(task.status, "cancelled");
});

test("notes are appended without altering task status", () => {
  const task = addTaskNote(createTask("t5", "Build", "a"), "Observed test failure", "b");
  assert.equal(task.status, "queued");
  assert.equal(task.events.at(-1)?.type, "note");
  assert.throws(() => addTaskNote(task, " ", "c"), /cannot be empty/);
});

test("transition query reflects allowed transitions", () => {
  assert.equal(canTransitionTask("queued", "planning"), true);
  assert.equal(canTransitionTask("queued", "completed"), false);
});
