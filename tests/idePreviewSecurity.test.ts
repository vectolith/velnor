import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewDocument } from "../src/lib/ide/workspace";
import { createDefaultWorkspace, addFile, updateContent } from "../src/lib/ide/workspace";

test("preview inlines workspace-local assets but preserves unresolved references", () => {
  const workspace = createDefaultWorkspace();
  const html = buildPreviewDocument(workspace.files);
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
  assert.doesNotMatch(html, /<script src=["']app\.js["']/);
  assert.doesNotMatch(html, /<link rel=["']stylesheet["'] href=["']styles\.css["']/);
});

test("preview adds restrictive CSP and disables external connections", () => {
  const workspace = createDefaultWorkspace();
  const html = buildPreviewDocument(workspace.files);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /base-uri 'none'/);
});

test("preview console bridge only posts its tagged messages and does not expose parent DOM", () => {
  const workspace = createDefaultWorkspace();
  const html = buildPreviewDocument(workspace.files);
  assert.match(html, /velnor-ide-console/);
  assert.match(html, /parent\.postMessage/);
  assert.match(html, /window\.addEventListener\("error"/);
  assert.doesNotMatch(html, /parent\.document/);
});

test("preview escapes closing script sequence in user script content", () => {
  const workspace = createDefaultWorkspace();
  const hostile = "</script><script>alert(1)</script>";
  const files = updateContent(workspace.files, workspace.files.find((f) => f.path === "app.js")!.id, hostile);
  const html = buildPreviewDocument(files);
  assert.match(html, /<\\\/script/);
  assert.doesNotMatch(html, /<script>\s*<\/script><script>alert\(1\)<\/script>/);
});

test("preview does not inline remote assets", () => {
  let files = createDefaultWorkspace().files;
  files = [...files, addFile(files, "remote.html", '<html><head><script src="https://example.invalid/x.js"></script><link href="https://example.invalid/x.css" rel="stylesheet"></head></html>')];
  const html = buildPreviewDocument(files);
  assert.match(html, /connect-src 'none'/);
});
