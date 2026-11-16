import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import type { Attachment } from "@/lib/types";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import {
  getExecutionTask, listExecutionTasks, requestExecutionTaskCancellation,
} from "@/lib/tasks/taskStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  return withVelnorTenantScope(tenant.userId, async () => {
    const { tenantId } = getNodeTenantRepositoryContext();
    return NextResponse.json({ tasks: listExecutionTasks(tenantId, 50) });
  });
}

export async function POST(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  const action = typeof input.action === "string" ? input.action : "";
  if (!/^task_[0-9a-f-]{36}$/i.test(taskId)) return NextResponse.json({ error: "A valid taskId is required." }, { status: 400 });

  return withVelnorTenantScope(tenant.userId, async () => {
    const { repository, tenantId } = getNodeTenantRepositoryContext();
    if (action === "cancel") {
      const changed = requestExecutionTaskCancellation(tenantId, taskId);
      const task = getExecutionTask(tenantId, taskId);
      if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
      if (!changed) return NextResponse.json({ task, error: "Task is no longer cancellable." }, { status: 409 });
      return NextResponse.json({ task: getExecutionTask(tenantId, taskId) });
    }
    if (action === "retry") {
      const task = getExecutionTask(tenantId, taskId);
      if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
      if (task.status !== "failed" && task.status !== "interrupted") {
        return NextResponse.json({ error: "Only failed or interrupted tasks can be retried.", task }, { status: 409 });
      }
      const record = await repository.load(tenantId);
      const messages = (record?.state as { messages?: Array<Record<string, unknown>> } | undefined)?.messages || [];
      const original = messages.find((message) =>
        message.sender === "user" && message.interactionId === taskId && typeof message.text === "string"
      );
      if (!original || typeof original.text !== "string") {
        return NextResponse.json({ error: "Original request is no longer available for retry.", task }, { status: 410 });
      }
      const reply = await processUserMessage({
        channel: task.channel,
        text: original.text,
        userHandle: task.userHandle || undefined,
        attachments: Array.isArray(original.attachments) ? original.attachments as Attachment[] : undefined,
      });
      return NextResponse.json({ taskId: reply.interactionId, reply });
    }
    return NextResponse.json({ error: "Action must be cancel or retry." }, { status: 400 });
  });
}
