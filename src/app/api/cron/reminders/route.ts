import { NextRequest, NextResponse } from "next/server";
import { dispatchReminderNotification } from "@/lib/scheduler";
import { getStore } from "@/lib/store";

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
