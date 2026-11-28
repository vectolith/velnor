import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import PreviewPane from "../src/app/ide/PreviewPane";
import { createDefaultWorkspace } from "../src/lib/ide/workspace";

test("preview iframe is sandboxed to scripts without same-origin or navigation privileges", () => {
  const workspace = createDefaultWorkspace();
  const markup = renderToStaticMarkup(createElement(PreviewPane, {
    files: workspace.files,
    reloadKey: 0,
    onConsole: () => {},
    onClearConsole: () => {},
  }));
  const iframe = markup.match(/<iframe\b[^>]*>/i)?.[0];
  assert.ok(iframe, "preview must render an iframe");
  const sandbox = iframe.match(/\bsandbox="([^"]*)"/);
  assert.ok(sandbox, "preview iframe must have a sandbox attribute");
  assert.equal(sandbox[1], "allow-scripts", "preview must grant only script execution");
  assert.doesNotMatch(sandbox[1], /allow-same-origin|allow-top-navigation|allow-forms|allow-popups|allow-downloads/);
});
