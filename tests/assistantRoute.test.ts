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
      return new Response(JSON.stringify({ choices: [{ message: { content: "  generated reply  " } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const response = await POST(request("hello", "test-success-1"));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { reply: "generated reply", model: "test-model" });
      assert.equal(captured?.method, "POST");
      assert.equal(captured?.redirect, "error");
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
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
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

test("assistant route rejects UTF-8 prompts above the byte limit", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const response = await POST(request("é".repeat(48_001), "test-large-prompt-1"));
    assert.equal(response.status, 413);
  });
});

test("assistant route caps streamed provider response bytes", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("x".repeat(2_000_001), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const response = await POST(request("hello", "test-large-response-1"));
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /exceeded the allowed size/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route enforces request size even without Content-Length", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const oversized = new NextRequest("http://localhost/api/ide/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "test-stream-limit-1", authorization: "Bearer test-provider-key" },
      body: JSON.stringify({ prompt: "x".repeat(130_000) }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach provider"); };
    try {
      const response = await POST(oversized);
      assert.equal(response.status, 413);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("assistant route rejects non-JSON content types", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const badRequest = new NextRequest("http://localhost/api/ide/chat", { method: "POST", headers: { "content-type": "text/plain", "x-real-ip": "test-content-type-1" }, body: JSON.stringify({ prompt: "hello" }) });
    const response = await POST(badRequest);
    assert.equal(response.status, 415);
  });
});


test("assistant route rejects malformed JSON without calling the provider", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const bad = new NextRequest("http://localhost/api/ide/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "test-malformed-json-1" }, body: "{invalid" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach provider"); };
    try {
      const response = await POST(bad);
      assert.equal(response.status, 400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route rejects a successful provider response with a non-JSON content type", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] }), { status: 200, headers: { "content-type": "text/plain" } });
    try {
      const response = await POST(request("hello", "test-provider-content-type-1"));
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /response type/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route maps provider connection and timeout failures to a generic 502", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("private timeout details"); };
    try {
      const response = await POST(request("hello", "test-provider-timeout-1"));
      assert.equal(response.status, 502);
      assert.ok(!(await response.text()).includes("private timeout details"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route rate-limits after twelve requests in the same bucket", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      for (let i = 0; i < 12; i += 1) {
        const response = await POST(request("hello", "test-rate-limit-bucket-1"));
        assert.equal(response.status, 200);
      }
      const limited = await POST(request("hello", "test-rate-limit-bucket-1"));
      assert.equal(limited.status, 429);
      assert.equal(calls, 12);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("assistant route returns 401 when neither request nor server key is configured", async () => {
  await withEnv({ VELNOR_AI_API_KEY: undefined, VELNOR_AI_BASE_URL: "https://provider.example/v1" }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("must not reach provider"); };
    try {
      const response = await POST(request("hello", "test-no-key-1", ""));
      assert.equal(response.status, 401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
