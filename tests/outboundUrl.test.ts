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
const response = (statusCode: number, body: string, headers: Record<string, string> = {}) => ({
  statusCode,
  headers,
  body: Buffer.from(body),
});

test("private address detection covers loopback, RFC1918, link-local and CGNAT", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "203.0.113.1", "::1", "fe80::1", "fd00::1", "2001:db8::1", "2002::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address + " should be private");
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address + " should be public");
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
  await assert.rejects(
    () => safeFetchText("https://example.com/start", {
      resolve: publicResolver,
      request: async () => response(302, "", { location: "http://169.254.169.254/latest/meta-data" }),
    }),
    /Blocked private address|Blocked host/
  );
});

test("a body larger than the ceiling is refused", async () => {
  await assert.rejects(
    () => safeFetchText("https://example.com/big", {
      resolve: publicResolver,
      maxBytes: 1000,
      request: async () => response(200, "x".repeat(5000), { "content-type": "text/html" }),
    }),
    /exceeded|too large/i
  );
});

test("a disallowed content type is refused", async () => {
  await assert.rejects(
    () => safeFetchText("https://example.com/blob", {
      resolve: publicResolver,
      request: async () => response(200, "binary", { "content-type": "application/octet-stream" }),
    }),
    /Unsupported content type/
  );
});

test("a normal page is returned bounded and intact", async () => {
  const result = await safeFetchText("https://example.com/", {
    resolve: publicResolver,
    request: async () => response(200, "<html>hello</html>", { "content-type": "text/html" }),
  });
  assert.equal(result.text, "<html>hello</html>");
  assert.equal(result.contentType, "text/html");
});

test("an upstream error status is surfaced, not swallowed", async () => {
  await assert.rejects(
    () => safeFetchText("https://example.com/down", {
      resolve: publicResolver,
      request: async () => response(502, "nope"),
    }),
    /Upstream returned 502/
  );
});

test("a transport failure propagates as an error", async () => {
  await assert.rejects(
    () => safeFetchText("https://example.com/boom", {
      resolve: publicResolver,
      request: async () => { throw new Error("ECONNREFUSED"); },
    }),
    /ECONNREFUSED/
  );
});
