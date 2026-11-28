import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkspace, updateContent, addFile } from "../src/lib/ide/workspace";
import { createSnapshot, restoreSnapshot, compareSnapshot, retainSnapshots, parseSnapshotHistory } from "../src/lib/ide/snapshots";

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
  let next = { ...base, files: [...base.files, addFile(base.files, "extra.txt", "new")] };
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

test("checkpoint history loads from validated JSON and trims old entries to the byte budget", () => {
  const workspace = createDefaultWorkspace();
  const old = createSnapshot({ ...workspace, files: updateContent(workspace.files, workspace.activeId, "x".repeat(2000)) }, "old", "old", "1");
  const newest = createSnapshot(workspace, "new", "new", "2");
  const budget = new TextEncoder().encode(JSON.stringify([newest])).byteLength + 10;
  const retained = retainSnapshots([old], newest, 20, budget);
  assert.deepEqual(retained.map((item) => item.id), ["new"]);
  assert.deepEqual(parseSnapshotHistory(JSON.stringify(retained)).map((item) => item.id), ["new"]);
});

test("checkpoint history rejects malformed JSON, duplicate ids, paths and invalid entry paths", () => {
  const snapshot = createSnapshot(createDefaultWorkspace(), "s1", "baseline", "a");
  assert.throws(() => parseSnapshotHistory("{invalid"), /valid JSON/);
  assert.throws(() => parseSnapshotHistory(JSON.stringify([snapshot, snapshot])), /ids must be unique/);
  const duplicatePaths = { ...snapshot, files: [...snapshot.files, { ...snapshot.files[0], id: "other" }] };
  assert.throws(() => parseSnapshotHistory(JSON.stringify([duplicatePaths])), /duplicate file paths/);
  assert.throws(() => parseSnapshotHistory(JSON.stringify([{ ...snapshot, entry: "../escape.html" }])), /Paths cannot escape/);
});

test("a checkpoint larger than the configured history budget is rejected", () => {
  const workspace = createDefaultWorkspace();
  const large = createSnapshot({ ...workspace, files: updateContent(workspace.files, workspace.activeId, "x".repeat(3000)) }, "large", "large", "a");
  assert.throws(() => retainSnapshots([], large, 20, 1000), /exceeds the checkpoint-history byte limit/);
});
