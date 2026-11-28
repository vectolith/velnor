import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("preview iframe is sandboxed to scripts without same-origin or navigation privileges", () => {
  const source = readFileSync("src/app/ide/PreviewPane.tsx", "utf8");
  const iframe = source.match(/<iframe\b[\s\S]*?\/>/i)?.[0];
  assert.ok(iframe, "preview component must render an iframe");
  const sandbox = iframe.match(/\bsandbox="([^"]*)"/);
  assert.ok(sandbox, "preview iframe must have a sandbox attribute");
  assert.equal(sandbox[1], "allow-scripts", "preview must grant only script execution");
  assert.match(iframe, /srcDoc=\{document\.html\}/);
  assert.doesNotMatch(sandbox[1], /allow-same-origin|allow-top-navigation|allow-forms|allow-popups|allow-downloads/);
});
