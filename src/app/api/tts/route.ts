import { NextRequest, NextResponse } from "next/server";
import { generateSpeechWithProvider } from "@/lib/tools/multimodal";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorUser } from "@/lib/store";

export async function POST(req: NextRequest) {
  try {
    const tenant = authorizeChatTenant(req.headers.get('authorization'));
    if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
    const body = await req.json();
    const text = String(body.text || "").trim();
    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }
    const result = await withVelnorUser(tenant.userId, () => generateSpeechWithProvider(text));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TTS failed" },
      { status: 500 }
    );
  }
}
