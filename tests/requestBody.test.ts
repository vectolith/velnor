import assert from "node:assert/strict";
import test from "node:test";
import { PayloadTooLargeError, readRequestBodyLimited } from "../src/lib/security/requestBody";

test("bounded request reader accepts bodies within the byte limit", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: "small payload",
  });
  assert.equal(await readRequestBodyLimited(request, 32), "small payload");
});

test("bounded request reader rejects an oversized declared body before reading", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "content-length": "100" },
    body: "small",
  });
  await assert.rejects(
    readRequestBodyLimited(request, 10),
    (error: unknown) => error instanceof PayloadTooLargeError
  );
});

test("bounded request reader stops a streamed body when it exceeds the limit", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.enqueue(new TextEncoder().encode("67890"));
      controller.close();
    },
  });
  const request = new Request("https://example.test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    readRequestBodyLimited(request, 8),
    (error: unknown) => error instanceof PayloadTooLargeError
  );
});
