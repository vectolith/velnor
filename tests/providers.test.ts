import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider, toAnthropicMessages } from "../src/lib/ai/providers/anthropic";
import { GeminiProvider, toGeminiContents } from "../src/lib/ai/providers/gemini";
import { OpenAIProvider, toOpenAIMessages } from "../src/lib/ai/providers/openai";
import { Turn } from "../src/lib/ai/providers/types";

const transcript: Turn[] = [
  { role: "user", text: "weather in Paris?" },
  {
    role: "assistant",
    text: "",
    toolCalls: [{ id: "c1", name: "web_search", args: { query: "paris weather" } }],
  },
  { role: "tool", toolCallId: "c1", name: "web_search", content: '{"summary":"sunny"}' },
];

function stubFetch(payload: any, status = 200) {
  const calls: any[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

test("openai transcript keeps tool call ids", () => {
  const msgs = toOpenAIMessages("sys", transcript);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[2].tool_calls[0].id, "c1");
  assert.equal(msgs[3].tool_call_id, "c1");
});

test("gemini transcript uses functionCall/functionResponse", () => {
  const contents = toGeminiContents(transcript);
  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts[0].functionCall.name, "web_search");
  assert.equal(contents[2].parts[0].functionResponse.name, "web_search");
});

test("anthropic transcript uses tool_use/tool_result", () => {
  const msgs = toAnthropicMessages(transcript);
  assert.equal(msgs[1].content[0].type, "tool_use");
  assert.equal(msgs[2].content[0].type, "tool_result");
});

test("openai adapter parses tool calls and usage", async () => {
  stubFetch({
    model: "gpt-4o",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: "call_9", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const res = await new OpenAIProvider("k").complete({
    model: "gpt-4o",
    system: "s",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
  });
  assert.equal(res.toolCalls[0].name, "web_search");
  assert.deepEqual(res.toolCalls[0].args, { query: "x" });
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
});

test("gemini adapter parses functionCall parts", async () => {
  stubFetch({
    candidates: [
      {
        content: {
          parts: [
            { text: "checking" },
            { functionCall: { name: "web_search", args: { query: "y" } } },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
  });
  const res = await new GeminiProvider("k").complete({
    model: "gemini-2.5-flash",
    system: "s",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
  });
  assert.equal(res.text, "checking");
  assert.equal(res.toolCalls[0].name, "web_search");
  assert.equal(res.usage.inputTokens, 7);
});

test("anthropic adapter parses tool_use blocks", async () => {
  stubFetch({
    model: "claude-sonnet-4-20250514",
    content: [
      { type: "text", text: "one sec" },
      { type: "tool_use", id: "tu1", name: "web_search", input: { query: "z" } },
    ],
    usage: { input_tokens: 4, output_tokens: 2 },
  });
  const res = await new AnthropicProvider("k").complete({
    model: "claude-sonnet-4-20250514",
    system: "s",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
  });
  assert.equal(res.toolCalls[0].id, "tu1");
  assert.equal(res.usage.outputTokens, 2);
});

test("provider errors surface status and body", async () => {
  stubFetch({ error: "bad key" }, 401);
  await assert.rejects(
    () =>
      new OpenAIProvider("k").complete({
        model: "gpt-4o",
        system: "s",
        messages: [{ role: "user", text: "hi" }],
        tools: [],
      }),
    /HTTP 401/
  );
});
