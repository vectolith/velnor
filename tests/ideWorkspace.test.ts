import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceError,
  addFile,
  buildPreviewDocument,
  createDefaultWorkspace,
  detectLanguage,
  entryFile,
  normalizePath,
  removeFile,
  renameFile,
  sortFiles,
  updateContent,
} from "../src/lib/ide/workspace";

test("normalizePath strips redundant segments and rejects escapes", () => {
  assert.equal(normalizePath(" ./src//app.tsx "), "src/app.tsx");
  assert.equal(normalizePath("a/b/../c.html"), "a/c.html");
  assert.throws(() => normalizePath("../secrets.txt"), WorkspaceError);
  assert.throws(() => normalizePath("   "), WorkspaceError);
});

test("detectLanguage maps extensions", () => {
  assert.equal(detectLanguage("index.html"), "html");
  assert.equal(detectLanguage("styles.css"), "css");
  assert.equal(detectLanguage("app.js"), "javascript");
  assert.equal(detectLanguage("types.ts"), "typescript");
  assert.equal(detectLanguage("data.json"), "json");
  assert.equal(detectLanguage("notes.md"), "markdown");
  assert.equal(detectLanguage("LICENSE"), "plaintext");
});

test("default workspace opens on its entry file", () => {
  const workspace = createDefaultWorkspace();
  assert.equal(workspace.entry, "index.html");
  assert.equal(workspace.files.length, 3);
  assert.equal(workspace.files[0].id, workspace.activeId);
});

test("addFile refuses duplicate paths and dedupes instead", () => {
  const workspace = createDefaultWorkspace();
  const added = addFile(workspace.files, "index.html", "<p>again</p>");
  assert.equal(added.path, "index-2.html");
  assert.notEqual(added.id, workspace.files[0].id);
});

test("renameFile keeps paths unique", () => {
  const workspace = createDefaultWorkspace();
  const renamed = renameFile(workspace.files, workspace.files[2].id, "styles.css");
  assert.equal(renamed[2].path, "styles-2.css");
  assert.equal(renamed[1].path, "styles.css");
});

test("removeFile and updateContent are immutable", () => {
  const workspace = createDefaultWorkspace();
  const next = updateContent(workspace.files, workspace.files[2].id, "console.log(1)");
  assert.equal(next[2].content, "console.log(1)");
  assert.notEqual(workspace.files[2].content, "console.log(1)");
  const trimmed = removeFile(next, workspace.files[2].id);
  assert.equal(trimmed.length, 2);
});

test("buildPreviewDocument inlines local css and js", () => {
  const workspace = createDefaultWorkspace();
  const html = buildPreviewDocument(workspace.files);
  assert.ok(html.includes("place-items: center"));
  assert.ok(html.includes("setInterval(tick, 1000)"));
  assert.ok(!html.includes("<link rel=\"stylesheet\""));
  assert.ok(html.includes("velnor-ide-console"));
});

test("buildPreviewDocument escapes closing script tags inside inlined js", () => {
  const files = [
    { id: "a", path: "index.html", content: "<html><head></head><body><script src=\"evil.js\"></script></body></html>" },
    { id: "b", path: "evil.js", content: "document.write('</script><img src=x>')" },
  ];
  const html = buildPreviewDocument(files);
  assert.ok(html.includes("<\\/script"));
  assert.ok(!html.includes("</script><img"));
});

test("buildPreviewDocument explains a missing entry", () => {
  assert.throws(() => buildPreviewDocument([]), WorkspaceError);
});

test("entryFile falls back to any html document", () => {
  const files = [{ id: "x", path: "page.html", content: "<html></html>" }];
  assert.equal(entryFile(files)?.id, "x");
});

test("sortFiles orders by path and keeps every file", () => {
  const workspace = createDefaultWorkspace();
  const sorted = sortFiles(workspace.files);
  assert.deepEqual(sorted.map((file) => file.path), ["app.js", "index.html", "styles.css"]);
});

test("preview includes restrictive CSP to block network and external resource access", () => {
  const html = buildPreviewDocument(createDefaultWorkspace().files);
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes("object-src 'none'"));
  assert.ok(html.includes("frame-src 'none'"));
  assert.ok(html.includes("form-action 'none'"));
});

test("file size limit is measured in UTF-8 bytes", () => {
  const workspace = createDefaultWorkspace();
  const multibyte = "é".repeat(262_145);
  assert.throws(() => addFile(workspace.files, "large.txt", multibyte), WorkspaceError);
});
