import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedUrl,
  isPrivateAddress,
  OutboundUrlError,
  resolveAndAssert,
  safeFetchText,
} from "../src/lib/security/outboundUrl";

const publicResolver = async () => ["93.184.216.34"];
const inwardResolver = async () => ["10.0.0.7"];

test("private address detection covers loopback, RFC1918, link-local and CGNAT", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("non-http schemes, credentials and blocked hostnames are refused", () => {
  assert.throws(() => assertAllowedUrl("file:///etc/passwd"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("ftp://example.com/x"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("http://user:pass@example.com/"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("http://localhost:3000/"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("http://metadata.google.internal/"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("http://printer.local/"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("http://169.254.169.254/latest/meta-data"), OutboundUrlError);
  assert.throws(() => assertAllowedUrl("not a url"), OutboundUrlError);
});

test("a public hostname resolving to a private address is refused", async () => {
  await assert.rejects(() => resolveAndAssert("https://evil.example.com/", { resolve: inwardResolver }), OutboundUrlError);
  const ok = await resolveAndAssert("https://example.com/", { resolve: publicResolver });
  assert.equal(ok.hostname, "example.com");
});

test("redirects are revalidated at every hop", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })) as typeof fetch;
    await assert.rejects(
      () => safeFetchText("https://example.com/start", { resolve: publicResolver }),
      /Blocked private address|Blocked host/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a body larger than the ceiling is refused", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("x".repeat(5000), { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await assert.rejects(
      () => safeFetchText("https://example.com/big", { resolve: publicResolver, maxBytes: 1000 }),
      /exceeded|too large/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a disallowed content type is refused", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } })) as typeof fetch;
    await assert.rejects(
      () => safeFetchText("https://example.com/blob", { resolve: publicResolver }),
      /Unsupported content type/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a normal page is returned bounded and intact", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    const result = await safeFetchText("https://example.com/", { resolve: publicResolver });
    assert.equal(result.text, "<html>hello</html>");
    assert.equal(result.contentType, "text/html");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
