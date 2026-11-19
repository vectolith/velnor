import {
  CompletionRequest,
  Provider,
  ProviderError,
  ToolSpec,
  Turn,
  Usage,
  addUsage,
  emptyUsage,
} from "./providers/types";

export interface ToolRunResult {
  /** JSON-serialisable payload handed back to the model. */
  payload: Record<string, any>;
  /** Optional short status line for the UI/log. */
  status?: "success" | "info" | "error";
}

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  system: string;
  messages: Turn[];
  tools: ToolSpec[];
  executeTool: (name: string, args: Record<string, any>) => Promise<ToolRunResult>;
  maxSteps?: number;
  maxOutputTokens?: number;
  toolTimeoutMs?: number;
  /** Upper bound on tool calls executed in parallel within one model turn. */
  maxParallelTools?: number;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  text: string;
  usage: Usage;
  steps: number;
  toolCalls: number;
  /** Tool calls answered from the in-run cache instead of being re-executed. */
  cachedToolCalls: number;
  model: string;
  /** Set when the loop stopped because it hit maxSteps. */
  truncated: boolean;
}

const DEFAULT_MAX_STEPS = Number(process.env.VELNOR_MAX_STEPS || 6);
const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.VELNOR_TOOL_TIMEOUT_MS || 30_000);
const DEFAULT_MAX_PARALLEL_TOOLS = Number(process.env.VELNOR_MAX_PARALLEL_TOOLS || 4);
const TOOL_PAYLOAD_BUDGET = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tool " + label + " timed out after " + ms + "ms")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Stable key for an identical tool call, so repeats can be answered from cache. */
function callKey(name: string, args: Record<string, any>): string {
  const canonical = (value: any): any => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, any>>((acc, k) => {
          acc[k] = canonical(value[k]);
          return acc;
        }, {});
    }
    return value;
  };
  try {
    return name + "\u0000" + JSON.stringify(canonical(args));
  } catch {
    return name + "\u0000" + String(args);
  }
}

/**
 * Serialise a tool payload for the transcript. Over-budget payloads are
 * replaced by valid JSON that says so, instead of a string cut mid-structure
 * which some models cannot parse at all.
 */
export function serialiseToolPayload(payload: Record<string, any>, budget = TOOL_PAYLOAD_BUDGET): string {
  const full = JSON.stringify(payload ?? {});
  if (full.length <= budget) return full;
  const preview = full.slice(0, Math.max(0, budget - 200));
  return JSON.stringify({
    truncated: true,
    originalBytes: full.length,
    note: "Payload exceeded the transcript budget. Re-request a narrower slice if you need more.",
    preview,
  });
}

export function summariseToolResult(ran: ToolRunResult, cached: boolean): string {
  const status = ran.status ? String(ran.status) : undefined;
  if (!cached) return status ?? "success";
  return status ? status + " (cached)" : "success (cached)";
}

/**
 * One loop, every provider. Keeps calling tools until the model answers
 * without a tool call, or until maxSteps. Tool failures never abort the turn:
 * the model receives the error and gets a chance to recover.
 *
 * Independent tool calls in the same model turn run concurrently up to
 * maxParallelTools, and an identical successful call (same name and args) is
 * answered from the run cache rather than executed twice.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxParallel = Math.max(1, Math.floor(opts.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS));
  const transcript: Turn[] = [...opts.messages];
  let usage: Usage = emptyUsage();
  let toolCallCount = 0;
  let cachedToolCalls = 0;
  let model = opts.model;
  const cache = new Map<string, Record<string, any>>();

  const runOne = async (name: string, args: Record<string, any>) => {
    try {
      const ran = await withTimeout(opts.executeTool(name, args), toolTimeoutMs, name);
      return { payload: ran.payload ?? {}, ok: true as const };
    } catch (err) {
      return { payload: { error: err instanceof Error ? err.message : String(err) }, ok: false as const };
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    const req: CompletionRequest = {
      model,
      system: opts.system,
      messages: transcript,
      tools: opts.tools,
      maxOutputTokens: opts.maxOutputTokens,
      signal: opts.signal,
    };
    const result = await opts.provider.complete(req);
    usage = addUsage(usage, result.usage);
    model = result.model || model;

    if (!result.toolCalls.length) {
      const text = (result.text || "").trim();
      if (!text) {
        throw new ProviderError(
          opts.provider.id + " returned an empty reply",
          opts.provider.id,
          200,
          false
        );
      }
      return {
        text,
        usage,
        steps: step + 1,
        toolCalls: toolCallCount,
        cachedToolCalls,
        model,
        truncated: false,
      };
    }

    transcript.push({ role: "assistant", text: result.text || undefined, toolCalls: result.toolCalls });

    const calls = result.toolCalls;
    toolCallCount += calls.length;

    const outcomes: Record<string, any>[] = new Array(calls.length);
    const pending: { index: number; name: string; args: Record<string, any>; key: string }[] = [];

    calls.forEach((call, index) => {
      const args = call.args || {};
      const key = callKey(call.name, args);
      const hit = cache.get(key);
      if (hit) {
        outcomes[index] = hit;
        cachedToolCalls++;
        return;
      }
      pending.push({ index, name: call.name, args, key });
    });

    // Collapse duplicates that arrived in the same turn so each unique call
    // runs exactly once, however many times the model asked for it.
    const unique = new Map<string, { name: string; args: Record<string, any>; indices: number[] }>();
    for (const p of pending) {
      const existing = unique.get(p.key);
      if (existing) {
        existing.indices.push(p.index);
        cachedToolCalls++;
      } else {
        unique.set(p.key, { name: p.name, args: p.args, indices: [p.index] });
      }
    }

    const jobs = [...unique.entries()];
    for (let i = 0; i < jobs.length; i += maxParallel) {
      const batch = jobs.slice(i, i + maxParallel);
      const settled = await Promise.all(batch.map(([, job]) => runOne(job.name, job.args)));
      settled.forEach((outcome, n) => {
        const [key, job] = batch[n];
        for (const index of job.indices) outcomes[index] = outcome.payload;
        if (outcome.ok) cache.set(key, outcome.payload);
      });
    }

    calls.forEach((call, index) => {
      const payload = outcomes[index] ?? { error: "Tool result missing" };
      transcript.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: serialiseToolPayload(payload),
      });
    });
  }

  // Out of steps: ask once more so the user still gets an answer built from
  // what the model already learned.
  const final = await opts.provider.complete({
    model,
    system: opts.system,
    messages: [
      ...transcript,
      {
        role: "user",
        text: "You have used the available tool steps. Answer now using what you have. If a step failed, say so plainly.",
      } as Turn,
    ],
    tools: [],
    maxOutputTokens: opts.maxOutputTokens,
    signal: opts.signal,
  });
  usage = addUsage(usage, final.usage);
  return {
    text: (final.text || "").trim(),
    usage,
    steps: maxSteps,
    toolCalls: toolCallCount,
    cachedToolCalls,
    model: final.model || model,
    truncated: true,
  };
}
