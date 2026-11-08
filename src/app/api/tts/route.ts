import { NextRequest, NextResponse } from "next/server";
import { generateSpeechWithProvider } from "@/lib/tools/multimodal";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = String(body.text || "").trim();
    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }
    const result = await generateSpeechWithProvider(text);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TTS failed" },
      { status: 500 }
    );
  }
}
