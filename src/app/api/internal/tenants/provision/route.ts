import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getStore, listUserIds, sanitizeUserId, saveStore, withVelnorUser } from "@/lib/store";

export const runtime = "nodejs";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Internal, idempotent tenant provisioning endpoint for the trusted identity
 * gateway. It is not a public signup API: only the gateway knows the separate
 * provisioning secret and it derives tenant IDs from verified upstream subjects.
 */
export async function POST(req: NextRequest) {
  const expected = process.env.VELNOR_PROVISIONING_SECRET || "";
  if (expected.length < 32) {
    return NextResponse.json({ error: "Tenant provisioning is not configured." }, { status: 503 });
  }

  const supplied = req.headers.get("x-velnor-provisioning-secret") || "";
  if (!safeEqual(supplied, expected)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 4096) {
    return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4096) return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const tenantId = (body as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== "string" || !/^cf-[a-f0-9]{64}$/.test(tenantId)) {
    return NextResponse.json({ error: "Invalid gateway tenant identifier." }, { status: 400 });
  }

  const storageId = sanitizeUserId(tenantId);
  const existing = new Set(listUserIds().map((id) => sanitizeUserId(id)));
  if (!existing.has(storageId)) {
    await withVelnorUser(tenantId, () => {
      saveStore(getStore());
    });
  }

  return NextResponse.json({ ok: true, tenantId });
}
