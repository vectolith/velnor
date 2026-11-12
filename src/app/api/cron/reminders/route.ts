import { NextRequest, NextResponse } from "next/server";
import { dispatchReminderNotification } from "@/lib/scheduler";
import { getStore } from "@/lib/store";\nimport { authorizeCronRequest } from "@/lib/security/webhookAuth";\n\nfunction requireCronAuth(req: NextRequest): NextResponse | null {\n  const decision = authorizeCronRequest(process.env.CRON_SECRET, req.headers.get("authorization")?.replace(/^Bearer\\s+/i, ""));\n  if (decision.ok) return null;\n  return NextResponse.json({ error: decision.error }, { status: decision.status ?? 401, headers: { "Cache-Control": "no-store" } });\n}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const reminderId = body.reminderId ? String(body.reminderId) : undefined;
    const dispatched = await dispatchReminderNotification(reminderId);
    const state = getStore();
    return NextResponse.json({
      ok: true,
      dispatchedCount: dispatched.length,
      dispatched,
      reminders: state.reminders,
      messages: state.messages,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to dispatch reminders" },
      { status: 500 }
    );
  }
}

export async function GET() {
  const dispatched = await dispatchReminderNotification();
  return NextResponse.json({
    ok: true,
    dispatchedCount: dispatched.length,
    dispatched,
  });
}
