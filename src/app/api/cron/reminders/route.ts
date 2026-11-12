import { NextRequest, NextResponse } from "next/server";
import { dispatchReminderNotification } from "@/lib/scheduler";
import { getStore } from "@/lib/store";
import { authorizeCronRequest } from "@/lib/security/webhookAuth";
import { PayloadTooLargeError, readRequestBodyLimited } from "@/lib/security/requestBody";

function requireCronAuth(req: NextRequest): NextResponse | null {
  const authorization = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const decision = authorizeCronRequest(process.env.CRON_SECRET, match?.[1]);
  if (decision.ok) return null;
  return NextResponse.json(
    { error: decision.error },
    { status: decision.status ?? 401, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;

  try {
    let body: { reminderId?: unknown } = {};
    try {
      const raw = await readRequestBodyLimited(req, 16 * 1024);
      if (raw) body = JSON.parse(raw) as { reminderId?: unknown };
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return NextResponse.json({ error: error.message }, { status: 413 });
      }
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
    }
    const reminderId = body.reminderId ? String(body.reminderId) : undefined;
    const dispatched = await dispatchReminderNotification(reminderId);
    const state = getStore();
    return NextResponse.json(
      {
        ok: true,
        dispatchedCount: dispatched.length,
        dispatched,
        reminders: state.reminders,
        messages: state.messages,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to dispatch reminders" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function GET(req: NextRequest) {
  const denied = requireCronAuth(req);
  if (denied) return denied;
  try {
    const dispatched = await dispatchReminderNotification();
    return NextResponse.json(
      { ok: true, dispatchedCount: dispatched.length, dispatched },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to dispatch reminders" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
