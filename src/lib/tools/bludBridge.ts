/**
 * Velnor <-> Blud Kernel Browser Automation Bridge
 * ===============================================
 * Wires Blud's Kernel-powered browser automation coordinator into Velnor's
 * agent tool pipeline. Allows Velnor to delegate multi-step web navigation,
 * form filling, authenticated workflows, and scraping directly to Blud over
 * an internal RPC with strict execution verification and zero fabrication.
 */

export interface BrowserTaskOptions {
  task: string;
  startUrl?: string;
  extractSchema?: Record<string, unknown>;
  sessionRef?: string;
  timeoutMs?: number;
}

export interface BrowserTaskResult {
  status: "success" | "failure" | "offline";
  summary: string;
  currentUrl?: string;
  extractedData?: Record<string, unknown>;
  images?: string[];
  error?: string;
  verifiedAtUtc: string;
}

const DEFAULT_BLUD_RPC_URL =
  process.env.BLUD_INTERNAL_RPC_URL || "http://127.0.0.1:3000/api/internal/browser-worker";
const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Delegate a multi-step browser navigation task to Blud's Kernel coordinator.
 */
export async function delegateBrowserTaskToBlud(
  options: BrowserTaskOptions
): Promise<BrowserTaskResult> {
  const { task, startUrl, extractSchema, sessionRef, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const verifiedAtUtc = new Date().toISOString();

  if (!task || task.trim().length === 0) {
    return {
      status: "failure",
      summary: "Browser delegation failed: no task instruction provided.",
      verifiedAtUtc,
      error: "Task instructions must not be empty.",
    };
  }

  // 1. Attempt internal RPC to Blud browser agent
  const rpcUrl = DEFAULT_BLUD_RPC_URL;
  const sharedSecret =
    process.env.BLUD_INTERNAL_KEY ||
    process.env.VELNOR_SHARED_SECRET ||
    process.env.VELNOR_ADMIN_TOKEN ||
    "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Velnor-Agent/1.0 (Vectolith)",
    };
    if (sharedSecret) {
      headers["x-blud-key"] = sharedSecret;
      headers["Authorization"] = `Bearer ${sharedSecret}`;
    }

    const payload = {
      message: task,
      startUrl,
      extractSchema,
      sessionRef,
      caller: "velnor",
    };

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      if (!data || data.status !== "success") {
        return {
          status: data?.status === "offline" ? "offline" : "failure",
          summary: data?.message || data?.summary || "Blud did not confirm successful browser execution.",
          error: data?.error || "Coordinator response did not contain status=success.",
          verifiedAtUtc,
        };
      }
      return {
        status: "success",
        summary: data.message || data.summary || "Browser task completed and confirmed by Blud.",
        currentUrl: typeof data.currentUrl === "string" ? data.currentUrl : startUrl,
        extractedData: data.data || data.extractedData,
        images: Array.isArray(data.images) ? data.images : [],
        verifiedAtUtc,
      };
    }

    // Server responded with non-200
    const errBody = await res.text().catch(() => "");
    return {
      status: "failure",
      summary: `Blud browser coordinator returned HTTP ${res.status}`,
      error: errBody.slice(0, 500) || `HTTP ${res.status}`,
      verifiedAtUtc,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const isConnRefused =
      err instanceof Error &&
      (err.message.includes("fetch failed") ||
        err.message.includes("ECONNREFUSED") ||
        err.message.includes("ENOTFOUND"));

    if (isTimeout) {
      return {
        status: "failure",
        summary: `Browser task timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        error: "Execution exceeded timeout budget.",
        verifiedAtUtc,
      };
    }

    if (isConnRefused) {
      // Epistemic honesty: acknowledge coordinator is not reachable on the local port
      return {
        status: "offline",
        summary:
          "Blud Kernel browser coordinator is not actively listening on " +
          rpcUrl +
          ". Ensure Blud is running (`npm run dev` in blud) or set BLUD_INTERNAL_RPC_URL.",
        error: "Blud RPC coordinator unreachable.",
        verifiedAtUtc,
      };
    }

    return {
      status: "failure",
      summary: "Browser task delegation failed unexpectedly.",
      error: err instanceof Error ? err.message : String(err),
      verifiedAtUtc,
    };
  }
}
