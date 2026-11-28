import { NextRequest, NextResponse } from "next/server";

/**
 * The IDE assistant backend. Velnor ships only the editor; the assistant is
 * bring-your-own-key: the browser sends the provider key as a bearer token and
 * this route forwards it to an OpenAI-compatible chat-completions endpoint.
 *
 * Server-side fallbacks (so a deployment can hold the key instead of the user):
 *   VELNOR_AI_API_KEY  - provider key
 *   VELNOR_AI_BASE_URL - defaults to https://api.openai.com/v1
 *   VELNOR_AI_MODEL    - defaults to gpt-4o-mini
 */

export const runtime = "nodejs";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_PROMPT_BYTES = 96_000;
const MAX_REQUEST_BYTES = 128_000;
const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_MODEL_CHARS = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 12;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimitKey(req: NextRequest): string {
  // Forwarded headers are only trustworthy when the deployment proxy strips
  // client-supplied values and injects its own. Otherwise use a shared fallback.
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || req.headers.get("x-real-ip") || "unknown";
  return candidate.slice(0, 128);
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateBuckets.size > 10_000) {
      for (const [bucketKey, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
      // Bound memory even if an attacker supplies a stream of unique IP values.
      if (rateBuckets.size > 10_000) {
        const oldest = rateBuckets.keys().next().value;
        if (oldest) rateBuckets.delete(oldest);
      }
    }
    return false;
  }
  current.count += 1;
  return current.count > RATE_LIMIT_REQUESTS;
}

const SYSTEM_PROMPT =
  "You are Velnor, an assistant embedded in a browser code editor. Answer with code or short explanations. When the user names a file, assume it is the file they have open. Do not claim to have changed files: the user applies your reply manually.";

type ChatBody = {
  prompt?: unknown;
  model?: unknown;
};

function bearerToken(req: NextRequest): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

export async function GET() {
  return NextResponse.json({
    service: "Velnor IDE assistant",
    baseUrl: process.env.VELNOR_AI_BASE_URL || DEFAULT_BASE_URL,
    model: process.env.VELNOR_AI_MODEL || DEFAULT_MODEL,
    serverKeyConfigured: Boolean(process.env.VELNOR_AI_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  if (isRateLimited(rateLimitKey(req))) {
    return NextResponse.json({ error: "Too many requests. Please wait before retrying." }, { status: 429 });
  }

  const declaredLength = Number(req.headers.get('content-length') || 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
  }

  let body: ChatBody;
  try {
    if (!req.body) return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(bytes)) as ChatBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Send a non-empty prompt." }, { status: 400 });
  }
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  if (promptBytes > MAX_PROMPT_BYTES) {
    return NextResponse.json({ error: 'Prompt is too long (96 KB UTF-8 limit).' }, { status: 413 });
  }

  const apiKey = bearerToken(req) || process.env.VELNOR_AI_API_KEY || "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "No API key. Paste a provider key in the assistant panel or set VELNOR_AI_API_KEY." },
      { status: 401 },
    );
  }

  const configuredBaseUrl = process.env.VELNOR_AI_BASE_URL || DEFAULT_BASE_URL;
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(configuredBaseUrl);
  } catch {
    return NextResponse.json({ error: "The configured provider endpoint is invalid." }, { status: 500 });
  }
  if (!["https:", "http:"].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    return NextResponse.json({ error: "The configured provider endpoint must use HTTP(S) without embedded credentials." }, { status: 500 });
  }
  const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, "");
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  if (requestedModel.length > MAX_MODEL_CHARS) {
    return NextResponse.json({ error: "Model identifier is too long." }, { status: 400 });
  }
  const model = requestedModel || process.env.VELNOR_AI_MODEL || DEFAULT_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the model provider. Check the endpoint and try again." }, { status: 502 });
  }

  const declaredResponseLength = Number(upstream.headers.get('content-length') || 0);
  if (declaredResponseLength > MAX_PROVIDER_RESPONSE_BYTES) {
    return NextResponse.json({ error: 'The provider response exceeded the allowed size.' }, { status: 502 });
  }
  let raw: string;
  try {
    if (!upstream.body) throw new Error('empty body');
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: 'The provider response exceeded the allowed size.' }, { status: 502 });
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    raw = new TextDecoder().decode(merged);
  } catch {
    return NextResponse.json({ error: 'The provider response could not be read.' }, { status: 502 });
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!upstream.ok) {
    // Avoid echoing raw provider bodies: they may contain sensitive diagnostics.
    return NextResponse.json(
      { error: "The model provider returned HTTP " + upstream.status + ". Check provider configuration and credentials." },
      { status: 502 },
    );
  }

  const choice = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0];
  const reply = choice?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) {
    return NextResponse.json({ error: "The provider returned no message content." }, { status: 502 });
  }

  return NextResponse.json({ reply: reply.trim(), model });
}
