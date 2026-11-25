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
const MAX_PROMPT_CHARS = 24_000;

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
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Send a non-empty prompt." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: "Prompt is too long (" + prompt.length + " chars, limit " + MAX_PROMPT_CHARS + ")." },
      { status: 413 },
    );
  }

  const apiKey = bearerToken(req) || process.env.VELNOR_AI_API_KEY || "";
  if (!apiKey) {
    return NextResponse.json(
      { error: "No API key. Paste a provider key in the assistant panel or set VELNOR_AI_API_KEY." },
      { status: 401 },
    );
  }

  const baseUrl = (process.env.VELNOR_AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : process.env.VELNOR_AI_MODEL || DEFAULT_MODEL;

  let upstream: Response;
  try {
    upstream = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown network error";
    return NextResponse.json({ error: "Could not reach the model provider: " + message }, { status: 502 });
  }

  const raw = await upstream.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }

  if (!upstream.ok) {
    const detail =
      payload && typeof payload === "object"
        ? (() => {
            const err = (payload as { error?: unknown }).error;
            if (typeof err === "string") return err;
            if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
              return (err as { message: string }).message;
            }
            return raw.slice(0, 500);
          })()
        : raw.slice(0, 500);
    return NextResponse.json(
      { error: "Provider error " + upstream.status + ": " + detail },
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
