import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkspace, updateContent } from "../src/lib/ide/workspace";
import { createSnapshot } from "../src/lib/ide/snapshots";
import { buildChangePreflight } from "../src/lib/ide/preflight";

test("preflight reports changed files and workspace observations", () => {
  const w = createDefaultWorkspace();
  const s = createSnapshot(w, "s", "baseline", "now");
  const files = updateContent(w.files, w.files[0].id, '<script src="https://remote.invalid/a.js"></script>');
  const r = buildChangePreflight({ ...w, files }, s);
  assert.ok(r.changed.includes("index.html"));
  assert.ok(r.findings.some((x) => x.message.includes("remote script")));
});

test("preflight reports removed files and inventory", () => {
  const w = createDefaultWorkspace();
  const s = createSnapshot(w, "s2", "baseline", "now");
  const r = buildChangePreflight({ ...w, files: w.files.slice(1) }, s);
  assert.ok(r.removed.includes("index.html"));
  assert.equal(r.fileCount, 2);
  assert.ok(r.totalBytes > 0);
});

test("preflight reports entry-file changes", () => {
  const w = createDefaultWorkspace();
  const s = createSnapshot(w, "s3", "baseline", "now");
  const r = buildChangePreflight({ ...w, entry: "src/main.html" }, s);
  assert.equal(r.entryChanged, true);
  assert.ok(r.findings.some((x) => x.message.includes("Entry file changed")));
});
