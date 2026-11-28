import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewDocument } from "../src/lib/ide/workspace";
import { createDefaultWorkspace, updateContent } from "../src/lib/ide/workspace";

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

test("preview preserves remote assets without attempting to inline them", () => {
  const workspace = createDefaultWorkspace();
  const index = workspace.files.find((f) => f.path === "index.html")!;
  const remoteHtml = '<!doctype html><html><head><link rel="stylesheet" href="https://example.invalid/x.css"></head><body><script src="https://example.invalid/x.js"></script></body></html>';
  const files = updateContent(workspace.files, index.id, remoteHtml);
  const html = buildPreviewDocument(files);
  assert.match(html, /https:\\/\\/example\\.invalid\\/x\\.css/);
  assert.match(html, /https:\\/\\/example\\.invalid\\/x\\.js/);
  assert.match(html, /connect-src 'none'/);
});

test("preview neutralizes a hostile closing style sequence in workspace CSS", () => {
  const workspace = createDefaultWorkspace();
  const hostile = "body{} </style><script>alert(1)</script>";
  const files = updateContent(workspace.files, workspace.files.find((f) => f.path === "styles.css")!.id, hostile);
  const html = buildPreviewDocument(files);
  assert.doesNotMatch(html, /<style>\\s*body\\{\\}\\s*<\\/style><script>alert\\(1\\)<\\/script>/);
  assert.match(html, /<\\\\\/style/);
});
