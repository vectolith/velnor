import assert from "node:assert/strict";
import test from "node:test";
import { splitForSms, toPlainText } from "../src/lib/format";

test("strips markdown that SMS would render literally", () => {
  const out = toPlainText("**bold** and _italic_ and \`code\`\n## Heading\n[link](https://x.test)");
  assert.equal(out.includes("**"), false);
  assert.equal(out.includes("##"), false);
  assert.equal(out.includes("_italic_"), false);
  assert.match(out, /link \(https:\/\/x\.test\)/);
});

test("splits long replies on paragraph boundaries", () => {
  const para = "a".repeat(400);
  const parts = splitForSms([para, para, para, para, para].join("\n\n"), 900, 4);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 900));
});

test("short replies are untouched", () => {
  assert.deepEqual(splitForSms("hello"), ["hello"]);
});
