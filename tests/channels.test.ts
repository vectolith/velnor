import assert from "node:assert/strict";
import test from "node:test";
import { sendSendblueMessage } from "../src/lib/channels/sendblue";
import { sendLoopMessage } from "../src/lib/channels/loopmessage";
import { buildSlackBlocks, postSlackMessage } from "../src/lib/channels/slack";
import type { ChatMessage } from "../src/lib/types";

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(input, init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("sendblue sends the documented headers and body", async () => {
  let seen: { url: string; headers: any; body: any } | null = null;
  const restore = stubFetch((input, init) => {
    seen = { url: String(input), headers: init?.headers, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ status: "OK" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const result = await sendSendblueMessage({ apiKeyId: "key", apiSecretKey: "secret", number: "+15550100", content: "hi" });
    assert.equal(result.ok, true);
    assert.equal(result.provider, "sendblue");
    assert.equal(seen!.url, "https://api.sendblue.co/api/send-message");
    assert.equal(seen!.headers["sb-api-key-id"], "key");
    assert.equal(seen!.headers["sb-api-secret-key"], "secret");
    assert.deepEqual(seen!.body, { number: "+15550100", content: "hi" });
  } finally {
    restore();
  }
});

test("sendblue reports a provider rejection instead of claiming success", async () => {
  const restore = stubFetch(() => new Response("bad key", { status: 401 }));
  try {
    const result = await sendSendblueMessage({ apiKeyId: "key", apiSecretKey: "secret", number: "+1555", content: "hi" });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(String(result.detail), /bad key/);
  } finally {
    restore();
  }
});

test("sendblue refuses to run without credentials", async () => {
  const result = await sendSendblueMessage({ apiKeyId: "", apiSecretKey: "", number: "+1555", content: "hi" });
  assert.equal(result.ok, false);
  assert.match(String(result.detail), /not configured/);
});

test("loopmessage reports transport failures", async () => {
  const restore = stubFetch(() => {
    throw new Error("ECONNRESET");
  });
  try {
    const result = await sendLoopMessage({ authKey: "a", secretKey: "s", recipient: "+1555", text: "hi" });
    assert.equal(result.ok, false);
    assert.match(String(result.detail), /ECONNRESET/);
  } finally {
    restore();
  }
});

test("slack treats {ok:false} on a 200 as a failure", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const result = await postSlackMessage({ botToken: "xoxb", channel: "C1", text: "hi" });
    assert.equal(result.ok, false);
    assert.match(String(result.detail), /channel_not_found/);
  } finally {
    restore();
  }
});

test("slack posts to the channel with blocks and thread", async () => {
  let body: any = null;
  const restore = stubFetch((_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const result = await postSlackMessage({ botToken: "xoxb", channel: "C1", text: "hi", threadTs: "123.45" });
    assert.equal(result.ok, true);
    assert.equal(body.channel, "C1");
    assert.equal(body.thread_ts, "123.45");
  } finally {
    restore();
  }
});

test("block kit rendering escapes bold and attaches tool context", () => {
  const reply: ChatMessage = {
    id: "m1",
    channel: "slack",
    sender: "velnor",
    text: "**done**",
    timestamp: new Date().toISOString(),
    toolActions: [{ tool: "web_search", label: "Searched", status: "success" } as any],
    citations: [{ title: "Source", url: "https://example.com" } as any],
  };
  const blocks = buildSlackBlocks(reply);
  assert.equal(blocks[0].text.text, "*done*");
  assert.ok(blocks.some((block) => block.type === "context"));
});
