import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/lib/ai/loop";
import { CompletionRequest, CompletionResult, Provider } from "../src/lib/ai/providers/types";

class ScriptedProvider implements Provider {
  readonly id = "openai" as const;
  calls: CompletionRequest[] = [];
  constructor(private readonly script: CompletionResult[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

const base = { model: "m", system: "s", messages: [{ role: "user" as const, text: "hi" }], tools: [] };

test("executes a tool then answers", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "1", name: "web_search", args: { query: "q" } }],
      usage: { inputTokens: 5, outputTokens: 1 },
      model: "m",
    },
    { text: "final answer", toolCalls: [], usage: { inputTokens: 2, outputTokens: 3 }, model: "m" },
  ]);
  const seen: string[] = [];
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async (name) => {
      seen.push(name);
      return { payload: { ok: true } };
    },
  });
  assert.equal(res.text, "final answer");
  assert.deepEqual(seen, ["web_search"]);
  assert.equal(res.toolCalls, 1);
  assert.deepEqual(res.usage, { inputTokens: 7, outputTokens: 4 });
  // second call must include the tool result
  assert.equal(provider.calls[1].messages.at(-1)?.role, "tool");
});

test("tool failures are handed back to the model, not thrown", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "1", name: "boom", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "recovered", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async () => {
      throw new Error("kaboom");
    },
  });
  assert.equal(res.text, "recovered");
  const toolTurn = provider.calls[1].messages.at(-1) as any;
  assert.match(toolTurn.content, /kaboom/);
});

test("stops at maxSteps and asks for a final answer without tools", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "1", name: "loop", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "wrapped up", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  const res = await runAgentLoop({
    ...base,
    provider,
    maxSteps: 1,
    executeTool: async () => ({ payload: {} }),
  });
  assert.equal(res.truncated, true);
  assert.equal(res.text, "wrapped up");
  assert.equal(provider.calls[1].tools.length, 0);
});

test("independent tool calls in one turn run concurrently", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [
        { id: "1", name: "slow_a", args: {} },
        { id: "2", name: "slow_b", args: {} },
        { id: "3", name: "slow_c", args: {} },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  const started = Date.now();
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { payload: { ok: true } };
    },
  });
  const elapsed = Date.now() - started;
  assert.equal(res.toolCalls, 3);
  assert.ok(elapsed < 150, "three 60ms tools should not take 180ms, took " + elapsed + "ms");
});

test("identical repeated tool calls are answered from cache", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [
        { id: "1", name: "check", args: { b: 2, a: 1 } },
        { id: "2", name: "check", args: { a: 1, b: 2 } },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  let executions = 0;
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async () => {
      executions++;
      return { payload: { value: 42 } };
    },
  });
  assert.equal(executions, 1);
  assert.equal(res.cachedToolCalls, 1);
  const toolTurns = provider.calls[1].messages.filter((m) => m.role === "tool");
  assert.equal(toolTurns.length, 2);
  assert.match((toolTurns[1] as any).content, /42/);
});

test("a failed tool call is not cached, so a retry really runs again", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "1", name: "flaky", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    {
      text: "",
      toolCalls: [{ id: "2", name: "flaky", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  let attempts = 0;
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return { payload: { ok: true } };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(res.cachedToolCalls, 0);
});

test("oversized tool payloads stay valid JSON and are flagged", async () => {
  const provider = new ScriptedProvider([
    {
      text: "",
      toolCalls: [{ id: "1", name: "big", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    },
    { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "m" },
  ]);
  const res = await runAgentLoop({
    ...base,
    provider,
    executeTool: async () => ({ payload: { body: "x".repeat(40_000) } }),
  });
  assert.equal(res.text, "done");
  const toolTurn = provider.calls[1].messages.find((m) => m.role === "tool") as any;
  const parsed = JSON.parse(toolTurn.content);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.originalBytes > 40_000, true);
});

test("empty replies are an error so the caller can fall back", async () => {
  const provider = new ScriptedProvider([
    { text: "   ", toolCalls: [], usage: { inputTokens: 1, outputTokens: 0 }, model: "m" },
  ]);
  await assert.rejects(
    () => runAgentLoop({ ...base, provider, executeTool: async () => ({ payload: {} }) }),
    /empty reply/
  );
});
