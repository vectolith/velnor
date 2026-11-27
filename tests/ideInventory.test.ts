import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWorkspace } from "../src/lib/ide/inventory";

test("inventory deterministically summarizes files, entrypoints and dependencies", () => {
  const files = [
    { id: "1", path: "src/main.ts", content: "export {};" },
    { id: "2", path: "package.json", content: JSON.stringify({ dependencies: { zod: "1", react: "2" }, devDependencies: { vitest: "1" } }) },
    { id: "3", path: "notes.md", content: "hello" },
  ];
  const report = analyzeWorkspace(files);
  assert.equal(report.fileCount, 3);
  assert.equal(report.entrypoints[0], "src/main.ts");
  assert.deepEqual(report.dependencyNames, ["react", "vitest", "zod"]);
  assert.deepEqual(report.languages.map((x) => x.language), ["JSON", "Markdown", "TypeScript"]);
  assert.equal(report.observations.length, 0);
});

test("inventory reports invalid manifests and basic risk signals", () => {
  const report = analyzeWorkspace([
    { id: "a", path: "package.json", content: "not-json" },
    { id: "b", path: "index.html", content: '<script src="https://example.com/a.js"></script>' },
    { id: "c", path: "config.js", content: 'const api_key = "abcdefgh12345678";' },
  ]);
  assert.ok(report.observations.some((x) => x.code === "invalid-package-json"));
  assert.ok(report.observations.some((x) => x.code === "remote-script"));
  assert.ok(report.observations.some((x) => x.code === "possible-secret"));
});

test("inventory counts UTF-8 bytes and unknown files", () => {
  const report = analyzeWorkspace([{ id: "a", path: "opaque.bin", content: "é" }]);
  assert.equal(report.totalBytes, 2);
  assert.deepEqual(report.languages, [{ language: "Other", files: 1 }]);
});
