import assert from "node:assert/strict";
import test from "node:test";
import { parseProposedFileChanges } from "../src/lib/ide/workspace";

test("extracts path-labelled fenced proposals and preserves content", () => {
  const reply = "Apply these:\n\n```tsx src/App.tsx\nexport default function App() { return <main />; }\n```\n\n```css styles.css\nbody { margin: 0; }\n```";
  assert.deepEqual(parseProposedFileChanges(reply), [
    { path: "src/App.tsx", content: "export default function App() { return <main />; }" },
    { path: "styles.css", content: "body { margin: 0; }" },
  ]);
});

test("normalizes paths and ignores duplicate paths and root escapes", () => {
  const reply = "```js src/a.js\nfirst\n```\n\n```js src/./a.js\nsecond\n```\n\n```js ../../escape.js\nnope\n```";
  assert.deepEqual(parseProposedFileChanges(reply), [{ path: "src/a.js", content: "first" }]);
});

test("returns empty for ordinary explanatory text", () => {
  assert.deepEqual(parseProposedFileChanges("No files changed. Here is a suggestion."), []);
});
