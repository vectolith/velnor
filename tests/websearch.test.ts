import assert from "node:assert/strict";
import test from "node:test";
import { extractReadableText, parseDuckDuckGoHtml } from "../src/lib/tools/webSearch";

const html = [
  '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>',
  '<a class="result__snippet">Snippet A</a></div>',
  '<div class="result"><a rel="nofollow" class="result__a" href="https://example.org/b">Example B</a>',
  '<a class="result__snippet">Snippet B</a></div>',
].join("\n");

test("parses duckduckgo html results and unwraps redirects", () => {
  const hits = parseDuckDuckGoHtml(html);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://example.com/a");
  assert.equal(hits[0].title, "Example A");
  assert.equal(hits[1].snippet, "Snippet B");
});

test("extracts article prose and drops chrome", () => {
  const page = [
    "<html><head><style>.x{}</style></head><body>",
    "<nav>menu menu menu</nav>",
    "<article>",
    "<p>" + "Real paragraph text. ".repeat(6) + "</p>",
    "<p>" + "Second paragraph here. ".repeat(6) + "</p>",
    "<script>alert(1)</script>",
    "</article></body></html>",
  ].join("");
  const text = extractReadableText(page);
  assert.match(text, /Real paragraph text/);
  assert.match(text, /Second paragraph/);
  assert.equal(text.includes("menu menu"), false);
  assert.equal(text.includes("alert"), false);
});
