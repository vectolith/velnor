import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getLoopMessageStatus, sendLoopMessage } from "@/lib/channels/loopmessage";
import { createLoopMessageDeliveryAttempt, finishLoopMessageDeliveryAttempt, getLatestLoopMessageDeliveryAttempt, getLoopMessageDelivery, markLoopMessageAttemptsUnknownIfStale, markLoopMessageDeliveryUnknownIfStale, recordLoopMessageQueued, updateLoopMessageProviderStatus } from "@/lib/channels/imessageDeliveryStore";
import type { Attachment } from "@/lib/types";
import { normalizeImessageIdentity } from "@/lib/channels/imessageIdentity";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import {
  getExecutionTask, getExecutionTaskRetry, listExecutionTasks, requestExecutionTaskCancellation,
} from "@/lib/tasks/taskStore";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  return withVelnorTenantScope(tenant.userId, async () => {
    const { tenantId } = getNodeTenantRepositoryContext();
    const tasks = listExecutionTasks(tenantId, 50).map((task) => ({
      ...task,
      delivery: task.channel === "imessage" ? getLoopMessageDelivery(tenantId, task.id) : null,
      deliveryAttempt: task.channel === "imessage" ? getLatestLoopMessageDeliveryAttempt(tenantId, task.id) : null,
    }));
    return NextResponse.json({ tasks });
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
    if (action === "retry_delivery") {
      const task = getExecutionTask(tenantId, taskId);
      if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
      if (task.channel !== "imessage" || !task.userHandle) {
        return NextResponse.json({ error: "This task has no iMessage recipient identity." }, { status: 409 });
      }
      // A missing callback does not mean failure. After the grace period,
      // reconcile the provider's authoritative status before permitting retry.
      markLoopMessageDeliveryUnknownIfStale(tenantId, taskId);
      markLoopMessageAttemptsUnknownIfStale(tenantId, taskId);
      let delivery = getLoopMessageDelivery(tenantId, taskId);
      const previousAttempt = getLatestLoopMessageDeliveryAttempt(tenantId, taskId);
      if (!delivery && previousAttempt?.status !== "failed") {
        return NextResponse.json({
          error: "No definitively failed delivery attempt is available. An in-flight, accepted, or ambiguous send is blocked to prevent duplicates.",
          attempt: previousAttempt,
        }, { status: 409 });
      }
      if (delivery.status === "delivered") {
        return NextResponse.json({ error: "This result has already been delivered.", delivery }, { status: 409 });
      }
      const record = await repository.load(tenantId);
      const config = (record?.state as { config?: Record<string, unknown> } | undefined)?.config || {};
      const authKey = typeof config.loopMessageAuthKey === "string" && config.loopMessageAuthKey
        ? config.loopMessageAuthKey : process.env.LOOPMESSAGE_AUTH_KEY || "";
      const senderId = (process.env.LOOPMESSAGE_SENDER_ID || "").trim();
      if (!authKey || !senderId) {
        return NextResponse.json({ error: "LoopMessage API key and explicit VELNOR sender ID are required." }, { status: 503 });
      }
      const originalSenderId = delivery?.senderId ?? previousAttempt?.senderId;
      const originalRecipient = delivery?.recipient ?? previousAttempt?.recipient;
      if (!originalSenderId || senderId !== originalSenderId || originalRecipient !== task.userHandle) {
        return NextResponse.json({
          error: "The configured LoopMessage sender or recipient differs from the original attempt; retry blocked to preserve delivery identity.",
          delivery,
        }, { status: 409 });
      }
      if (delivery && (delivery.status === "queued" || delivery.status === "processing" || delivery.status === "unknown")) {
        const providerStatus = await getLoopMessageStatus({ authKey, messageId: delivery.messageId });
        if (!providerStatus.ok) {
          return NextResponse.json({
            error: "Could not reconcile LoopMessage delivery status; no retry was sent.",
            detail: providerStatus.detail,
          }, { status: 502 });
        }
        if (normalizeImessageIdentity(providerStatus.contact) !== delivery.recipient) {
          return NextResponse.json({ error: "LoopMessage status identity does not match the stored recipient; retry blocked." }, { status: 409 });
        }
        updateLoopMessageProviderStatus({
          messageId: delivery.messageId, tenantId, taskId,
          recipient: delivery.recipient, senderId: delivery.senderId,
          status: providerStatus.status, errorCode: providerStatus.errorCode,
        });
        delivery = getLoopMessageDelivery(tenantId, taskId);
      }
      if (delivery?.status === "delivered") {
        return NextResponse.json({ error: "This result has already been delivered.", delivery }, { status: 409 });
      }
      if (delivery && delivery.status !== "failed" && delivery.status !== "unknown") {
        return NextResponse.json({ error: "Delivery is not in a retryable state.", delivery }, { status: 409 });
      }
      const messages = (record?.state as { messages?: Array<Record<string, unknown>> } | undefined)?.messages || [];
      const resultMessage = messages.find((message) =>
        message.sender === "velnor" && message.interactionId === taskId && typeof message.text === "string"
      );
      if (!resultMessage || typeof resultMessage.text !== "string") {
        return NextResponse.json({ error: "The task has no completed result to deliver." }, { status: 409 });
      }
      const attempt = createLoopMessageDeliveryAttempt({
        tenantId, taskId, recipient: task.userHandle, senderId,
      });
      const sent = await sendLoopMessage({
        authKey, recipient: task.userHandle, text: String(resultMessage.text), senderId,
      });
      if (!sent.ok || !sent.messageId) {
        const definiteRejection = sent.status !== undefined &&
          sent.status >= 400 && sent.status < 500 && sent.status !== 408 && sent.status !== 429;
        finishLoopMessageDeliveryAttempt({
          attemptId: attempt.attemptId, tenantId, taskId,
          status: definiteRejection ? "failed" : "unknown",
          errorCode: sent.status, errorText: sent.detail,
        });
        return NextResponse.json({
          error: "LoopMessage did not confirm acceptance. The attempt has been durably recorded.",
          detail: sent.detail, attemptStatus: definiteRejection ? "failed" : "unknown",
        }, { status: 502 });
      }
      recordLoopMessageQueued({
        messageId: sent.messageId, tenantId, taskId, recipient: task.userHandle, senderId,
      });
      finishLoopMessageDeliveryAttempt({
        attemptId: attempt.attemptId, tenantId, taskId,
        status: "accepted", providerMessageId: sent.messageId,
      });
      return NextResponse.json({
        taskId, recipient: task.userHandle, senderId,
        deliveryStatus: "queued", messageId: sent.messageId,
        note: "Queued by LoopMessage; wait for message_delivered before treating this as delivered. A retry after an ambiguous timeout can duplicate a message because provider-side idempotency is not established.",
      });
    }
    if (action === "retry") {
      const task = getExecutionTask(tenantId, taskId);
      if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
      if (task.status !== "failed" && task.status !== "interrupted") {
        return NextResponse.json({ error: "Only failed or interrupted tasks can be retried.", task }, { status: 409 });
      }
      const existingRetry = getExecutionTaskRetry(tenantId, taskId);
      if (existingRetry) {
        return NextResponse.json({
          error: "This task already has a retry attempt. Retry the latest attempt instead.",
          retryTask: existingRetry,
        }, { status: 409 });
      }
      const record = await repository.load(tenantId);
      const messages = (record?.state as { messages?: Array<Record<string, unknown>> } | undefined)?.messages || [];
      const original = messages.find((message) =>
        message.sender === "user" && message.interactionId === taskId && typeof message.text === "string"
      );
      if (!original || typeof original.text !== "string") {
        return NextResponse.json({ error: "Original request is no longer available for retry.", task }, { status: 410 });
      }
      let reply: Awaited<ReturnType<typeof processUserMessage>>;
      try {
        reply = await processUserMessage({
          channel: task.channel,
          text: original.text,
          userHandle: task.userHandle || undefined,
          attachments: Array.isArray(original.attachments) ? original.attachments as Attachment[] : undefined,
          retryOfTaskId: task.id,
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("execution_tasks.retry_of")) {
          return NextResponse.json({ error: "A retry attempt was created concurrently. Refresh task history." }, { status: 409 });
        }
        throw error;
      }
      if (task.channel === "imessage") {
        if (!task.userHandle) return NextResponse.json({ error: "Original iMessage recipient identity is missing." }, { status: 409 });
        const refreshed = await repository.load(tenantId);
        const config = (refreshed?.state as { config?: Record<string, unknown> } | undefined)?.config || {};
        const authKey = typeof config.loopMessageAuthKey === "string" && config.loopMessageAuthKey
          ? config.loopMessageAuthKey : process.env.LOOPMESSAGE_AUTH_KEY || "";
        const senderId = (process.env.LOOPMESSAGE_SENDER_ID || "").trim();
        if (!authKey || !senderId) {
          return NextResponse.json({ error: "LoopMessage API key and explicit VELNOR sender ID are required." }, { status: 503 });
        }
        const deliveryAttempt = createLoopMessageDeliveryAttempt({
          tenantId, taskId: reply.interactionId || "", recipient: task.userHandle, senderId,
        });
        const sent = await sendLoopMessage({
          authKey, recipient: task.userHandle, text: reply.text, senderId,
        });
        if (!sent.ok || !sent.messageId) {
          const definiteRejection = sent.status !== undefined &&
            sent.status >= 400 && sent.status < 500 && sent.status !== 408 && sent.status !== 429;
          finishLoopMessageDeliveryAttempt({
            attemptId: deliveryAttempt.attemptId, tenantId, taskId: reply.interactionId || "",
            status: definiteRejection ? "failed" : "unknown",
            errorCode: sent.status, errorText: sent.detail,
          });
          return NextResponse.json({
            error: "The retried task completed, but LoopMessage did not confirm acceptance.",
            detail: sent.detail, taskId: reply.interactionId,
            deliveryAttemptStatus: definiteRejection ? "failed" : "unknown",
          }, { status: 502 });
        }
        recordLoopMessageQueued({
          messageId: sent.messageId, tenantId, taskId: reply.interactionId || "",
          recipient: task.userHandle, senderId,
        });
        finishLoopMessageDeliveryAttempt({
          attemptId: deliveryAttempt.attemptId, tenantId, taskId: reply.interactionId || "",
          status: "accepted", providerMessageId: sent.messageId,
        });
        return NextResponse.json({
          taskId: reply.interactionId, reply, recipient: task.userHandle, senderId,
          deliveryStatus: "queued", messageId: sent.messageId,
        });
      }
      return NextResponse.json({ taskId: reply.interactionId, reply });
    }
    return NextResponse.json({ error: "Action must be cancel, retry, or retry_delivery." }, { status: 400 });
  });
}
