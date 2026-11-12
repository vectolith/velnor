import { NextRequest, NextResponse } from "next/server";
import { dispatchReminderNotification } from "@/lib/scheduler";
import { getStore } from "@/lib/store";
import { authorizeCronRequest } from "@/lib/security/webhookAuth";

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
    const body = await req.json().catch(() => ({}));
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
