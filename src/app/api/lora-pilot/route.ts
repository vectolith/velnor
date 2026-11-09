import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

const LORA_SERVER_URL = process.env.OLLI_LORA_PILOT_URL || "http://127.0.0.1:8099";

function readJsonIfExists(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // ignore parse or read errors
  }
  return null;
}

export async function GET() {
  const trainingDir = path.join(process.cwd(), "training");
  const outputDir = path.join(trainingDir, "outputs", "olli-behavior-pilot");
  const committedReportPath = path.join(trainingDir, "pilot_report.json");

  const report =
    readJsonIfExists(path.join(outputDir, "report.json")) ??
    readJsonIfExists(committedReportPath);
  const generations = readJsonIfExists(path.join(outputDir, "generations.json"));
  const examples = readJsonIfExists(path.join(outputDir, "examples.json"));

  let adapterServerOnline = false;
  try {
    const res = await fetch(`${LORA_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(1200),
    });
    adapterServerOnline = res.ok;
  } catch {
    adapterServerOnline = false;
  }

  return NextResponse.json({
    status: report ? "trained" : "pending",
    adapterServerOnline,
    endpoint: `${LORA_SERVER_URL}/v1/chat`,
    report,
    generations,
    examplesCount: examples
      ? {
          training: examples.training?.length ?? 0,
          heldOut: examples.held_out?.length ?? 0,
        }
      : null,
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { message?: string };
    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json(
        { error: "Provide a non-empty 'message' string." },
        { status: 400 }
      );
    }

    const res = await fetch(`${LORA_SERVER_URL}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          error: `Local LoRA adapter server returned HTTP ${res.status}`,
        },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Local Olli CPU LoRA adapter server is offline. Start it with: training/.venv/Scripts/python.exe training/serve_adapter.py",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 503 }
    );
  }
}
