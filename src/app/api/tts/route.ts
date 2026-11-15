import { NextRequest, NextResponse } from "next/server";
import { generateSpeechWithProvider } from "@/lib/tools/multimodal";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorTenantScope } from "@/lib/store";
import { PayloadTooLargeError, readRequestBodyLimited } from "@/lib/security/requestBody";

export async function POST(req: NextRequest) {
  try {
    const tenant = authorizeChatTenant(req.headers.get('authorization'));
    if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
    let body: any;
    try {
      body = JSON.parse(await readRequestBodyLimited(req, 256 * 1024));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
    }
    const text = String(body.text || "").trim();
    if (text.length > 100_000) return NextResponse.json({ error: "Text exceeds the 100000-character limit." }, { status: 413 });
    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }
    const result = await withVelnorTenantScope(tenant.userId, () => generateSpeechWithProvider(text));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TTS failed" },
      { status: 500 }
    );
  }
}
