import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkspace, updateContent, addFile } from "../src/lib/ide/workspace";
import { createSnapshot, restoreSnapshot, compareSnapshot, retainSnapshots } from "../src/lib/ide/snapshots";

test("snapshot copies workspace and restore recreates files", () => {
  const workspace = createDefaultWorkspace();
  const snapshot = createSnapshot(workspace, "s1", "Before changes", "a");
  const modified = { ...workspace, files: updateContent(workspace.files, workspace.activeId, "modified") };
  assert.equal(compareSnapshot(snapshot, modified).changed.length, 1);
  const restored = restoreSnapshot(snapshot);
  assert.equal(restored.files[0].content, workspace.files[0].content);
});

test("snapshot comparison reports additions removals and changes", () => {
  const base = createDefaultWorkspace();
  const snapshot = createSnapshot(base, "s2", "baseline", "a");
  let next = { ...base, files: addFile(base.files, "extra.txt", "new") };
  next = { ...next, files: updateContent(next.files, base.activeId, "changed") };
  const diff = compareSnapshot(snapshot, next);
  assert.deepEqual(diff.added, ["extra.txt"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.removed.length, 0);
});

test("snapshot history is bounded and deduplicates ids", () => {
  const workspace = createDefaultWorkspace();
  const history = Array.from({ length: 3 }, (_, i) => createSnapshot(workspace, "s" + i, "snap", String(i)));
  const newer = createSnapshot(workspace, "s1", "replacement", "4");
  assert.deepEqual(retainSnapshots(history, newer, 2).map((item) => item.id), ["s2", "s1"]);
  assert.throws(() => retainSnapshots(history, newer, 0), /positive integer/);
});
