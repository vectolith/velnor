import { NextRequest, NextResponse } from "next/server";
import { processUserMessage } from "@/lib/ai/agent";
import { getSendblueMessageStatus } from "@/lib/channels/sendblue";
import { getLoopMessageDelivery, markLoopMessageDeliveryUnknownIfStale, updateLoopMessageProviderStatus } from "@/lib/channels/imessageDeliveryStore";
import {
  getLatestLoopMessageAttempt, listLoopMessageAttempts, recoverStaleLoopMessageAttempts,
  syncLoopMessageAttemptFromProviderStatus, type LoopMessageDeliveryAttempt,
} from "@/lib/channels/imessageDeliveryAttempts";
import { sendTrackedSendblueMessage } from "@/lib/channels/trackedSendblueSend";
import type { Attachment } from "@/lib/types";
import { normalizeImessageIdentity } from "@/lib/channels/imessageIdentity";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import {
  getExecutionTask, getExecutionTaskRetry, listExecutionTasks, requestExecutionTaskCancellation,
} from "@/lib/tasks/taskStore";

export const runtime = "nodejs";

/** Public, non-secret view of a durable outbound attempt. */
function describeAttempt(attempt: LoopMessageDeliveryAttempt | null) {
  if (!attempt) return null;
  return {
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attemptNo,
    state: attempt.state,
    messageId: attempt.messageId,
    recipient: attempt.recipient,
    senderId: attempt.senderId,
    errorCode: attempt.errorCode,
    errorDetail: attempt.errorDetail,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  return withVelnorTenantScope(tenant.userId, async () => {
    const { tenantId } = getNodeTenantRepositoryContext();
    const tasks = listExecutionTasks(tenantId, 50).map((task) => ({
      ...task,
      delivery: task.channel === "imessage" ? getLoopMessageDelivery(tenantId, task.id) : null,
      deliveryAttempts: task.channel === "imessage" ? listLoopMessageAttempts(tenantId, task.id) : [],
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
      // A send that died mid-request leaves a pending attempt; it is ambiguous,
      // never delivered and never silently failed.
      recoverStaleLoopMessageAttempts(tenantId, taskId);
      let delivery = getLoopMessageDelivery(tenantId, taskId);
      let attempt = getLatestLoopMessageAttempt(tenantId, taskId);
      if (delivery?.status === "delivered" || attempt?.state === "delivered") {
        return NextResponse.json({ error: "This result has already been delivered.", delivery, attempt: describeAttempt(attempt) }, { status: 409 });
      }
      if (attempt?.state === "pending_send") {
        return NextResponse.json({ error: "A Sendblue send is still in flight for this task; retry blocked.", delivery, attempt: describeAttempt(attempt) }, { status: 409 });
      }
      const record = await repository.load(tenantId);
      const config = (record?.state as { config?: Record<string, unknown> } | undefined)?.config || {};
      const apiKeyId = typeof config.sendblueApiKey === "string" && config.sendblueApiKey
        ? config.sendblueApiKey : process.env.SENDBLUE_API_KEY || "";
      const apiSecretKey = typeof config.sendblueApiSecret === "string" && config.sendblueApiSecret
        ? config.sendblueApiSecret : process.env.SENDBLUE_API_SECRET || "";
      const senderId = typeof config.sendblueFromNumber === "string" && config.sendblueFromNumber
        ? config.sendblueFromNumber : process.env.SENDBLUE_FROM_NUMBER || "";
      const statusCallback = process.env.VELNOR_PUBLIC_URL
        ? process.env.VELNOR_PUBLIC_URL.replace(/\/+$/, "") + "/api/webhooks/imessage"
        : "";
      if (!apiKeyId || !apiSecretKey || !senderId || !statusCallback) {
        return NextResponse.json({ error: "Sendblue API credentials, sender number, and VELNOR_PUBLIC_URL are required." }, { status: 503 });
      }
      // Preserve the original sender identity across retries and recovery.
      const originalSenderId = attempt?.senderId || delivery?.senderId || "";
      if (originalSenderId && originalSenderId !== senderId) {
        return NextResponse.json({
          error: "The configured Sendblue sender number differs from the sender used for the original attempt; retry blocked to preserve sender identity.",
          delivery, attempt: describeAttempt(attempt),
        }, { status: 409 });
      }
      const trackedMessageId = attempt?.messageId || delivery?.messageId || "";
      if (trackedMessageId && (!delivery || delivery.status === "queued" || delivery.status === "processing" || delivery.status === "unknown")) {
        const providerStatus = await getSendblueMessageStatus({
          apiKeyId, apiSecretKey, messageId: trackedMessageId,
        });
        if (!providerStatus.ok) {
          return NextResponse.json({
            error: "Could not reconcile Sendblue delivery status; no retry was sent.",
            detail: providerStatus.detail,
          }, { status: 502 });
        }
        const knownRecipient = attempt?.recipient || delivery?.recipient || "";
        if (
          normalizeImessageIdentity(providerStatus.recipient) !== normalizeImessageIdentity(knownRecipient) ||
          normalizeImessageIdentity(providerStatus.sender) !== normalizeImessageIdentity(originalSenderId || senderId)
        ) {
          return NextResponse.json({ error: "Sendblue status identity does not match the stored recipient or sender; retry blocked." }, { status: 409 });
        }
        updateLoopMessageProviderStatus({
          messageId: trackedMessageId, tenantId, taskId,
          recipient: knownRecipient, senderId: originalSenderId || senderId,
          status: providerStatus.status, errorCode: providerStatus.errorCode,
        });
        syncLoopMessageAttemptFromProviderStatus({
          tenantId, taskId, messageId: trackedMessageId,
          status: providerStatus.status, errorCode: providerStatus.errorCode,
          errorDetail: providerStatus.wasDowngraded
            ? "Sendblue downgraded to SMS; the message may have reached the recipient and an iMessage retry could duplicate it."
            : undefined,
        });
        delivery = getLoopMessageDelivery(tenantId, taskId);
        attempt = getLatestLoopMessageAttempt(tenantId, taskId);
      }
      if (delivery?.status === "delivered" || attempt?.state === "delivered") {
        return NextResponse.json({ error: "This result has already been delivered.", delivery, attempt: describeAttempt(attempt) }, { status: 409 });
      }
      if (attempt?.state === "queued" || attempt?.state === "processing") {
        return NextResponse.json({ error: "Delivery is not in a retryable state.", delivery, attempt: describeAttempt(attempt) }, { status: 409 });
      }
      // Retryable: an explicit provider rejection, an ambiguous attempt, or a task
      // that finished without any outbound attempt at all (never sent).
      const smsFallbackRisk = Boolean(attempt?.errorDetail?.includes("downgraded to SMS"));
      const duplicateRisk = attempt?.state === "unconfirmed" || attempt?.state === "unknown" || delivery?.status === "unknown" || smsFallbackRisk;
      const messages = (record?.state as { messages?: Array<Record<string, unknown>> } | undefined)?.messages || [];
      const resultMessage = messages.find((message) =>
        message.sender === "velnor" && message.interactionId === taskId && typeof message.text === "string"
      );
      if (!resultMessage || typeof resultMessage.text !== "string") {
        return NextResponse.json({ error: "The task has no completed result to deliver." }, { status: 409 });
      }
      const tracked = await sendTrackedSendblueMessage({
        apiKeyId, apiSecretKey, recipient: task.userHandle, content: String(resultMessage.text),
        fromNumber: senderId, statusCallback,
        tenantId, taskId, allowAmbiguousRetry: true,
      });
      if (!tracked.result.ok || !tracked.result.messageId || tracked.attempt.state === "failed") {
        return NextResponse.json({
          error: tracked.attempt.errorDetail?.includes("downgraded to SMS")
            ? "Sendblue used SMS fallback. VELNOR does not count this as iMessage delivery; an explicit retry may duplicate the content."
            : "Sendblue did not confirm this delivery attempt. The attempt is durably recorded and stays retryable.",
          detail: tracked.result.detail,
          attempt: describeAttempt(tracked.attempt),
          duplicateRisk: duplicateRisk || tracked.duplicateRisk,
        }, { status: 502 });
      }
      return NextResponse.json({
        taskId, recipient: task.userHandle, senderId,
        deliveryStatus: "queued", messageId: tracked.result.messageId,
        attempt: describeAttempt(tracked.attempt),
        attemptNumber: tracked.attempt.attemptNo,
        duplicateRisk: duplicateRisk || tracked.duplicateRisk,
        trackingDegraded: tracked.trackingDegraded,
        note: "Queued by Sendblue; wait for an authenticated DELIVERED callback with service=iMessage before treating this as delivered. " +
          (smsFallbackRisk
            ? "A previous attempt may have reached the recipient by SMS; this iMessage retry may duplicate the content."
            : duplicateRisk
              ? "An earlier attempt had an unknown outcome, so this retry may be a duplicate because provider-side idempotency is not established."
              : "An earlier attempt was explicitly rejected or never sent."),
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
        const apiKeyId = typeof config.sendblueApiKey === "string" && config.sendblueApiKey
          ? config.sendblueApiKey : process.env.SENDBLUE_API_KEY || "";
        const apiSecretKey = typeof config.sendblueApiSecret === "string" && config.sendblueApiSecret
          ? config.sendblueApiSecret : process.env.SENDBLUE_API_SECRET || "";
        const senderId = typeof config.sendblueFromNumber === "string" && config.sendblueFromNumber
          ? config.sendblueFromNumber : process.env.SENDBLUE_FROM_NUMBER || "";
        const statusCallback = process.env.VELNOR_PUBLIC_URL
          ? process.env.VELNOR_PUBLIC_URL.replace(/\/+$/, "") + "/api/webhooks/imessage"
          : "";
        if (!apiKeyId || !apiSecretKey || !senderId || !statusCallback) {
          return NextResponse.json({ error: "Sendblue API credentials, sender number, and VELNOR_PUBLIC_URL are required." }, { status: 503 });
        }
        if (!reply.interactionId) {
          return NextResponse.json({ error: "The retried task did not produce a durable task identity; result delivery was not attempted." }, { status: 502 });
        }
        const tracked = await sendTrackedSendblueMessage({
          apiKeyId, apiSecretKey, recipient: task.userHandle, content: reply.text,
          fromNumber: senderId, statusCallback,
          tenantId, taskId: reply.interactionId,
        });
        if (!tracked.result.ok || !tracked.result.messageId || tracked.attempt.state === "failed") {
          return NextResponse.json({
            error: tracked.attempt.errorDetail?.includes("downgraded to SMS")
              ? "The retried task was sent through SMS fallback, not iMessage. A later retry may duplicate the content."
              : "The retried task completed, but Sendblue did not confirm result delivery. The attempt is durably recorded and retryable.",
            detail: tracked.result.detail,
            taskId: reply.interactionId,
            attempt: describeAttempt(tracked.attempt),
            duplicateRisk: tracked.duplicateRisk,
          }, { status: 502 });
        }
        return NextResponse.json({
          taskId: reply.interactionId, reply, recipient: task.userHandle, senderId,
          deliveryStatus: "queued", messageId: tracked.result.messageId,
          attempt: describeAttempt(tracked.attempt),
          attemptNumber: tracked.attempt.attemptNo,
          trackingDegraded: tracked.trackingDegraded,
        });
      }
      return NextResponse.json({ taskId: reply.interactionId, reply });
    }
    return NextResponse.json({ error: "Action must be cancel, retry, or retry_delivery." }, { status: 400 });
  });
}
