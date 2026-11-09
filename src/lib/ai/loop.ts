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
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  text: string;
  usage: Usage;
  steps: number;
  toolCalls: number;
  model: string;
  /** Set when the loop stopped because it hit maxSteps. */
  truncated: boolean;
}

const DEFAULT_MAX_STEPS = Number(process.env.VELNOR_MAX_STEPS || 6);
const DEFAULT_TOOL_TIMEOUT_MS = Number(process.env.VELNOR_TOOL_TIMEOUT_MS || 30_000);

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

/**
 * One loop, every provider. Keeps calling tools until the model answers
 * without a tool call, or until maxSteps. Tool failures never abort the turn:
 * the model receives the error and gets a chance to recover.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const transcript: Turn[] = [...opts.messages];
  let usage: Usage = emptyUsage();
  let toolCallCount = 0;
  let model = opts.model;

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
      return { text, usage, steps: step + 1, toolCalls: toolCallCount, model, truncated: false };
    }

    transcript.push({ role: "assistant", text: result.text || undefined, toolCalls: result.toolCalls });

    for (const call of result.toolCalls) {
      toolCallCount++;
      let payload: Record<string, any>;
      try {
        const ran = await withTimeout(
          opts.executeTool(call.name, call.args || {}),
          toolTimeoutMs,
          call.name
        );
        payload = ran.payload ?? {};
      } catch (err) {
        payload = { error: err instanceof Error ? err.message : String(err) };
      }
      transcript.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(payload).slice(0, 12_000),
      });
    }
  }

  // Out of steps: ask once more with tools disabled so the user still gets an
  // answer built from what the model already learned.
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
    model: final.model || model,
    truncated: true,
  };
}
