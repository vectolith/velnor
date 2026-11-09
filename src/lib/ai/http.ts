// Small fetch helper shared by the provider adapters.
//
// Everything here is transport-level: hard timeouts, bounded retries on 429
// and 5xx (respecting Retry-After), and a typed error the loop can decide on.

import { ProviderError, type ProviderId } from "./providers/types";

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  provider: ProviderId;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.VELNOR_PROVIDER_TIMEOUT_MS || 60000);
const DEFAULT_RETRIES = Number(process.env.VELNOR_PROVIDER_RETRIES || 2);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8000);
  }
  return Math.min(500 * 2 ** attempt, 4000);
}

/** POST/GET JSON with timeout + retry. Non-2xx throws ProviderError. */
export async function requestJson(url: string, opts: JsonRequestOptions): Promise<any> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: opts.method ?? "POST",
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const detail = "HTTP " + res.status + " from " + opts.provider + ": " + text.slice(0, 400);
        if (retryable && attempt < retries) {
          lastError = new ProviderError(detail, opts.provider, res.status, true);
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
        throw new ProviderError(detail, opts.provider, res.status, retryable);
      }

      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new ProviderError(
          opts.provider + " returned non-JSON body: " + text.slice(0, 200),
          opts.provider,
          res.status
        );
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.retryable && attempt < retries) {
          lastError = err;
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      const aborted = (err as Error)?.name === "AbortError";
      const message = aborted
        ? opts.provider + " request timed out after " + timeoutMs + "ms"
        : opts.provider + " request failed: " + ((err as Error)?.message || String(err));
      const wrapped = new ProviderError(message, opts.provider, undefined, !aborted);
      if (wrapped.retryable && attempt < retries) {
        lastError = wrapped;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ProviderError(opts.provider + " request failed", opts.provider);
}
