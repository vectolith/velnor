import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { authorizeChatTenant } from "@/lib/security/tenant";

const LORA_SERVER_URL = process.env.VELNOR_LORA_PILOT_URL || "http://127.0.0.1:8099";

function readJsonIfExists(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // Ignore malformed optional report files; never expose filesystem errors.
  }
  return null;
}

function requireTenant(req: NextRequest): NextResponse | null {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (tenant.ok) return null;
  return NextResponse.json(
    { error: tenant.error },
    { status: tenant.status ?? 401, headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(req: NextRequest) {
  const denied = requireTenant(req);
  if (denied) return denied;

  const trainingDir = path.join(process.cwd(), "training");
  const velnorDir = path.join(trainingDir, "outputs", "velnor-core-v1");
  const legacyDir = path.join(trainingDir, "outputs", "velnor-behavior-pilot");
  const activeDir = fs.existsSync(velnorDir) ? velnorDir : legacyDir;
  const committedReportPath = path.join(trainingDir, "pilot_report.json");
  const weightsPresent = fs.existsSync(path.join(activeDir, "adapter", "adapter_config.json"));

  const report =
    readJsonIfExists(path.join(activeDir, "report.json")) ??
    readJsonIfExists(committedReportPath);
  const generations = readJsonIfExists(path.join(activeDir, "generations.json"));
  const examples = readJsonIfExists(path.join(activeDir, "examples.json"));

  let adapterServerOnline = false;
  try {
    const res = await fetch(new URL("/health", LORA_SERVER_URL), {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    });
    adapterServerOnline = res.ok;
  } catch {
    adapterServerOnline = false;
  }

  return NextResponse.json(
    {
      agent: "Velnor",
      model: report?.model_name ?? null,
      status: weightsPresent ? "trained" : report ? "report-only" : "pending",
      weightsPresent,
      activeOutputDir: path.relative(process.cwd(), activeDir),
      adapterServerOnline,
      endpoint: "/api/lora-pilot",
      report,
      eval: report?.eval ?? null,
      provenance: report?.provenance ?? null,
      generations,
      examplesCount: examples
        ? {
            training: examples.training?.length ?? 0,
            heldOut: examples.held_out?.length ?? 0,
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const denied = requireTenant(req);
  if (denied) return denied;

  try {
    const raw = await req.text();
    if (raw.length > 8192) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    let body: { message?: unknown };
    try {
      body = JSON.parse(raw) as { message?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return NextResponse.json(
        { error: "Provide a non-empty 'message' string." },
        { status: 400 }
      );
    }
    if (message.length > 4000) {
      return NextResponse.json(
        { error: "Message exceeds the 4000-character limit." },
        { status: 413 }
      );
    }

    const res = await fetch(new URL("/v1/chat", LORA_SERVER_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Local LoRA adapter server returned HTTP ${res.status}` },
        { status: 502, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await res.json();
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Local Velnor LoRA adapter server is offline or unavailable.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
