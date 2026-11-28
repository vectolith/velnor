import test from "node:test";
import assert from "node:assert/strict";
import { parsePreviewConsoleMessage } from "../src/lib/ide/previewConsole";

test("rejects messages from any window other than the preview iframe", () => {
  assert.equal(parsePreviewConsoleMessage({ source: "velnor-ide-console", level: "log", text: "spoof" }, false), null);
});

test("rejects malformed payloads and messages without the bridge marker", () => {
  assert.equal(parsePreviewConsoleMessage(null, true), null);
  assert.equal(parsePreviewConsoleMessage([], true), null);
  assert.equal(parsePreviewConsoleMessage("string", true), null);
  assert.equal(parsePreviewConsoleMessage({ level: "log", text: "missing marker" }, true), null);
  assert.equal(parsePreviewConsoleMessage({ source: "other", level: "log", text: "wrong marker" }, true), null);
});

test("accepts bounded text and only known log levels", () => {
  assert.deepEqual(parsePreviewConsoleMessage({ source: "velnor-ide-console", level: "error", text: "failure" }, true), { level: "error", text: "failure" });
  const oversized = parsePreviewConsoleMessage({ source: "velnor-ide-console", level: "info", text: "x".repeat(9_000) }, true);
  assert.equal(oversized?.text.length, 8_000);
  assert.equal(parsePreviewConsoleMessage({ source: "velnor-ide-console", level: "danger", text: "fallback" }, true)?.level, "log");
});
