import test from "node:test";
import assert from "node:assert/strict";
import { buildPreviewDocument, createDefaultWorkspace, updateContent } from "../src/lib/ide/workspace";

test("preview inlines workspace local CSS and JS",()=>{
 const workspace=createDefaultWorkspace();
 const html=buildPreviewDocument(workspace.files);
 assert.match(html,/<style>[\s\S]*color-scheme: dark[\s\S]*<\/style>/);
 assert.match(html,/<script>[\s\S]*function tick[\s\S]*<\/script>/);
 assert.doesNotMatch(html,/<script src=["']app\.js["']/);
 assert.doesNotMatch(html,/<link rel=["']stylesheet["'] href=["']styles\.css["']/);
});
test("preview CSP disables connections, objects, frames and forms",()=>{
 const html=buildPreviewDocument(createDefaultWorkspace().files);
 assert.match(html,/Content-Security-Policy/);
 for(const directive of ["default-src 'none'","connect-src 'none'","object-src 'none'","frame-src 'none'","form-action 'none'","base-uri 'none'"]) assert.ok(html.includes(directive),directive);
});
test("preview console bridge tags and forwards errors but does not expose parent DOM",()=>{
 const html=buildPreviewDocument(createDefaultWorkspace().files);
 assert.match(html,/velnor-ide-console/);
 assert.match(html,/parent\.postMessage/);
 assert.match(html,/window\.addEventListener\("error"/);
 assert.doesNotMatch(html,/parent\.document/);
});
test("user script closing tags are neutralized before inline insertion",()=>{
 const workspace=createDefaultWorkspace();
 const hostile="const value = '</script><script>alert(1)</script>';"; 
 const files=updateContent(workspace.files,workspace.files.find(f=>f.path==='app.js')!.id,hostile);
 const html=buildPreviewDocument(files);
 assert.match(html,/<\\\/script/);
 assert.doesNotMatch(html,/<script>\s*const value = '<\/script><script>alert\(1\)<\/script>/);
});
test("remote assets are not inlined and remain blocked by CSP",()=>{
 const workspace=createDefaultWorkspace();
 const files=updateContent(workspace.files,workspace.files.find(f=>f.path==='index.html')!.id,'<!doctype html><html><head><link rel="stylesheet" href="https://example.invalid/style.css"><script src="https://example.invalid/app.js"></script></head><body></body></html>');
 const html=buildPreviewDocument(files);
 assert.match(html,/https:\/\/example\.invalid\/style\.css/);
 assert.match(html,/https:\/\/example\.invalid\/app\.js/);
 assert.match(html,/connect-src 'none'/);
});
