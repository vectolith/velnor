import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantWorkspaceContext } from "../src/lib/ide/inventory";

test("assistant context prioritizes active file and manifest within budget", () => {
  const files = [
    { id: "a", path: "large.md", content: "x".repeat(500) },
    { id: "b", path: "package.json", content: '{"dependencies":{"react":"1"}}' },
    { id: "c", path: "src/main.ts", content: "active content" },
  ];
  const context = buildAssistantWorkspaceContext(files, "src/main.ts", 800);
  assert.ok(context.includes("src/main.ts"));
  assert.ok(context.includes("package.json"));
  assert.ok(context.includes("omitted whole"));
  assert.ok(context.length <= 800);
});

test("assistant context omits files whole rather than truncating their content", () => {
  const context = buildAssistantWorkspaceContext([
    { id: "a", path: "huge.ts", content: "SENTINEL".repeat(1000) },
    { id: "b", path: "small.ts", content: "small-file-content" },
  ], "small.ts", 1200);
  assert.ok(context.includes("small-file-content"));
  assert.ok(!context.includes("SENTINEL"));
});
