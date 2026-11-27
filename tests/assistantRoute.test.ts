import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/ide/chat/route";

function request(prompt: unknown, ip: string, token = "test-provider-key", model?: string) {
  return new NextRequest("http://localhost/api/ide/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": ip,
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify({ prompt, ...(model ? { model } : {}) }),
  });
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("assistant route forwards valid prompts and returns provider content", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1", VELNOR_AI_MODEL: "test-model" }, async () => {
    const originalFetch = globalThis.fetch;
    let captured: RequestInit | undefined;
    globalThis.fetch = async (_input, init) => {
      captured = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: "  generated reply  " } }] }), { status: 200 });
    };
    try {
      const response = await POST(request("hello", "test-success-1"));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { reply: "generated reply", model: "test-model" });
      assert.equal(captured?.method, "POST");
      assert.equal(new Headers(captured?.headers).get("authorization"), "Bearer test-provider-key");
      assert.ok(String(captured?.body).includes('"prompt"') === false);
      assert.ok(String(captured?.body).includes('"content":"hello"'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route does not disclose provider response bodies on upstream errors", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("private provider diagnostic", { status: 401 });
    try {
      const response = await POST(request("hello", "test-error-1"));
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.ok(!JSON.stringify(body).includes("private provider diagnostic"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route rejects malformed successful provider payloads", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
    try {
      const response = await POST(request("hello", "test-invalid-payload-1"));
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /no message content/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route rejects provider URLs with embedded credentials", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://user:secret@provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("should not fetch"); };
    try {
      const response = await POST(request("hello", "test-invalid-url-1"));
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /credentials/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
