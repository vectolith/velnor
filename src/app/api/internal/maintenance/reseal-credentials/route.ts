import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStore, listUserIds, saveStore, withVelnorUser } from "@/lib/store";
import { secretsEnabled } from "@/lib/security/secretBox";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * One-time operator-only sweep for legacy tenant profiles. Loading a tenant
 * detects plaintext credential fields and reseals them; saveStore rewrites both
 * the SQLite record and JSON recovery mirror. This endpoint is intentionally
 * not routed through the public identity gateway.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.VELNOR_PROVISIONING_SECRET || "";
  const provided = req.headers.get("x-velnor-provisioning-secret") || "";
  if (expected.length < 32) {
    return NextResponse.json({ error: "Maintenance authentication is not configured." }, { status: 503 });
  }
  if (!safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!secretsEnabled()) {
    return NextResponse.json({ error: "Credential encryption is not configured." }, { status: 503 });
  }

  const tenantIds = listUserIds();
  let processed = 0;
  try {
    for (const tenantId of tenantIds) {
      await withVelnorUser(tenantId, () => {
        saveStore(getStore());
      });
      processed += 1;
    }
  } catch (error) {
    console.error("Credential reseal migration stopped after", processed, "tenant profiles:", error);
    return NextResponse.json(
      { error: "Credential migration did not complete.", processed },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { ok: true, processed, message: "Tenant credential records were resealed and persisted." },
    { headers: { "Cache-Control": "no-store" } }
  );
}
