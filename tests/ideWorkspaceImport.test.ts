import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultWorkspace, type IdeFile } from "../src/lib/ide/workspace";
import { parseWorkspaceBundle, stageWorkspaceImport } from "../src/lib/ide/workspaceImport";

const valid = JSON.stringify({schemaVersion:1,entry:"index.html",files:[{path:"index.html",content:"<html/>"},{path:"app.js",content:""}]});

test("bundle import validates schema, entry and path uniqueness",()=>{
  assert.equal(parseWorkspaceBundle(valid).files.length,2);
  assert.throws(()=>parseWorkspaceBundle("{"),/JSON/);
  assert.throws(()=>parseWorkspaceBundle(JSON.stringify({schemaVersion:1,entry:"missing.html",files:[{path:"index.html",content:""}]})),/entry file/);
  assert.throws(()=>parseWorkspaceBundle(JSON.stringify({schemaVersion:1,entry:"a",files:[{path:"a",content:""},{path:"A",content:""}]})),/duplicate/);
});
test("bundle import rejects traversal, oversized files and invalid records",()=>{
  assert.throws(()=>parseWorkspaceBundle(JSON.stringify({schemaVersion:1,entry:"../x",files:[{path:"../x",content:""}]})),/escape/);
  assert.throws(()=>parseWorkspaceBundle(JSON.stringify({schemaVersion:1,entry:"x",files:[{path:"x",content:"x".repeat(512*1024+1)}]})),/512 KB/);
  assert.throws(()=>parseWorkspaceBundle(JSON.stringify({schemaVersion:1,entry:"x",files:[null]})),/record/);
});
test("import staging is atomic and respects file capacity",()=>{
  const current=createDefaultWorkspace().files;
  const bundle=parseWorkspaceBundle(valid);
  assert.equal(stageWorkspaceImport(current,bundle).length,5);
  const full: IdeFile[]=Array.from({length:39},(_,i)=>({id:String(i),path:"f"+i+".txt",content:""}));
  assert.throws(()=>stageWorkspaceImport(full,bundle),/40-file/);
});
