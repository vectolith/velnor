import { resolveAndAssert } from "@/lib/security/outboundUrl";

export interface BrowserTaskOptions {
  task: string;
  startUrl?: string;
  extractSchema?: Record<string, unknown>;
  sessionRef?: string;
  timeoutMs?: number;
}

export interface BrowserExecutionReceipt {
  taskId: string;
  state: "completed";
  completedAtUtc: string;
  finalUrl: string;
  evidenceSha256: string;
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

const DEFAULT_BLUD_RPC_URL = "http://127.0.0.1:3000/api/internal/browser-worker";
const DEFAULT_TIMEOUT_MS = 45_000;

function configuredSharedSecret(): string {
  return (
    process.env.BLUD_INTERNAL_KEY ||
    process.env.VELNOR_SHARED_SECRET ||
    ""
  );
}

function isExecutionReceipt(value: unknown): value is BrowserExecutionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.taskId === "string" &&
    receipt.taskId.length > 0 &&
    receipt.state === "completed" &&
    typeof receipt.completedAtUtc === "string" &&
    Number.isFinite(Date.parse(receipt.completedAtUtc)) &&
    typeof receipt.finalUrl === "string" &&
    /^https?:\/\//i.test(receipt.finalUrl) &&
    typeof receipt.evidenceSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(receipt.evidenceSha256)
  );
}

/**
 * Delegate a browser task to Blud. A success response is accepted only when
 * Blud returns an authenticated, structurally valid completion receipt.
 */
export async function delegateBrowserTaskToBlud(
  options: BrowserTaskOptions
): Promise<BrowserTaskResult> {
  const { task, startUrl, extractSchema, sessionRef, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const receivedAtUtc = new Date().toISOString();

  if (!task || task.trim().length === 0) {
    return {
      status: "failure",
      summary: "Browser delegation failed: no task instruction provided.",
      verifiedAtUtc: receivedAtUtc,
      error: "Task instructions must not be empty.",
    };
  }

  if (task.length > 8000) {
    return {
      status: "failure",
      summary: "Browser task exceeds the 8,000-character limit.",
      verifiedAtUtc: receivedAtUtc,
      error: "Task instructions are too long.",
    };
  }

  const taskUrls = [startUrl, ...(task.match(/https?:\/\/[^\s)]+/g) || [])]
    .filter((value): value is string => Boolean(value));
  for (const url of taskUrls) await resolveAndAssert(url);

  const sharedSecret = configuredSharedSecret();
  if (!sharedSecret) {
    return {
      status: "failure",
      summary: "Browser delegation refused: Velnor-to-Blud service authentication is not configured.",
      error: "BLUD_INTERNAL_KEY or VELNOR_SHARED_SECRET must be configured before internal RPC.",
      verifiedAtUtc: receivedAtUtc,
    };
  }

  const rpcUrl = process.env.BLUD_INTERNAL_RPC_URL || DEFAULT_BLUD_RPC_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Velnor-Agent/1.0 (Vectolith)",
      "x-blud-key": sharedSecret,
      Authorization: `Bearer ${sharedSecret}`,
    };

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

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const offline = res.status === 502 || res.status === 503 || res.status === 504;
      return {
        status: offline ? "offline" : "failure",
        summary: `Blud browser coordinator returned HTTP ${res.status}`,
        error: errBody.slice(0, 500) || `HTTP ${res.status}`,
        verifiedAtUtc: receivedAtUtc,
      };
    }

    const data = await res.json();
    if (!data || data.status !== "success" || !isExecutionReceipt(data.executionReceipt)) {
      return {
        status: data?.status === "offline" ? "offline" : "failure",
        summary: data?.message || "Blud did not provide a verifiable browser execution receipt.",
        error: data?.error || "A success status without a valid executionReceipt is rejected.",
        verifiedAtUtc: receivedAtUtc,
      };
    }

    const receipt = data.executionReceipt;
    return {
      status: "success",
      summary: data.message || "Browser task completed with a verified execution receipt.",
      currentUrl: receipt.finalUrl,
      extractedData:
        data.data && typeof data.data === "object" && !Array.isArray(data.data)
          ? data.data
          : undefined,
      images: Array.isArray(data.images) ? data.images : [],
      verifiedAtUtc: receipt.completedAtUtc,
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
        error: "Execution exceeded timeout budget; completion is unknown.",
        verifiedAtUtc: receivedAtUtc,
      };
    }

    if (isConnRefused) {
      return {
        status: "offline",
        summary:
          "Blud browser coordinator is not reachable at " +
          rpcUrl +
          ". Ensure Blud is running or configure BLUD_INTERNAL_RPC_URL.",
        error: "Blud RPC coordinator unreachable.",
        verifiedAtUtc: receivedAtUtc,
      };
    }

    return {
      status: "failure",
      summary: "Browser task delegation failed unexpectedly.",
      error: err instanceof Error ? err.message : String(err),
      verifiedAtUtc: receivedAtUtc,
    };
  } finally {
    clearTimeout(timer);
  }
}
