import { randomUUID } from "node:crypto";
import { getStore, saveStore, resolveSlackChannel, listUserIds, withVelnorUser, currentUserId } from "./store";
import { claimReminderDispatch, completeReminderDispatch, releaseReminderDispatch } from "./sqliteDb";
import { sendTrackedSendblueMessage } from "./channels/trackedSendblueSend";
import { postSlackMessage } from "./channels/slack";
import { sendTwilioSms } from "./channels/twilio";
import { ChatMessage, ReminderItem } from "./types";

export interface DispatchedReminderResult {
  reminder: ReminderItem;
  deliveredVia: string[];
}

export async function dispatchReminderNotification(reminderId?: string): Promise<DispatchedReminderResult[]> {
  const userIds = new Set(listUserIds());
  userIds.add("default");
  const results: DispatchedReminderResult[] = [];
  for (const userId of userIds) {
    const tenantResults = await withVelnorUser(userId, () => dispatchTenantReminderNotification(reminderId));
    results.push(...tenantResults);
  }
  return results;
}

async function dispatchTenantReminderNotification(
  reminderId?: string
): Promise<DispatchedReminderResult[]> {
  const state = getStore();
  const now = Date.now();
  const pending = state.reminders.filter((reminder) => {
    if (reminder.completed) return false;
    if (reminderId) return reminder.id === reminderId;
    const dueAt = Date.parse(reminder.dueAt);
    return Number.isFinite(dueAt) && dueAt <= now;
  });

  const results: DispatchedReminderResult[] = [];
  const workerId = randomUUID();
  const completedReminderIds: string[] = [];
  const tenantId = currentUserId();

  for (const rem of pending.slice(0, reminderId ? 1 : 3)) {
    // A durable lease excludes overlapping cron workers and app processes.
    if (!claimReminderDispatch(tenantId, rem.id, workerId)) continue;

    try {
    const channelsUsed: string[] = [];
    const alertText = `🔔 **Velnor Reminder:** ${rem.text} _(Scheduled for ${rem.dueAt})_`;
    let deliveryAccepted = !rem.recipient;

    if (rem.channel === "imessage" && rem.recipient) {
      deliveryAccepted = false;
      const fromNumber = state.config.sendblueFromNumber || process.env.SENDBLUE_FROM_NUMBER || "";
      const statusCallback = process.env.VELNOR_PUBLIC_URL
        ? process.env.VELNOR_PUBLIC_URL.replace(/\/+$/, "") + "/api/webhooks/imessage"
        : "";
      if (state.config.sendblueApiKey && state.config.sendblueApiSecret && fromNumber) {
        const tracked = await sendTrackedSendblueMessage({
          apiKeyId: state.config.sendblueApiKey,
          apiSecretKey: state.config.sendblueApiSecret,
          recipient: rem.recipient,
          fromNumber,
          content: `🔔 Reminder from Velnor: ${rem.text}`,
          statusCallback,
          tenantId,
          taskId: "reminder_" + rem.id,
        });
        if (tracked.result.ok && tracked.result.messageId) {
          // Provider acceptance is not delivery. The callback remains the
          // authoritative delivered state; the reminder is queued only once.
          deliveryAccepted = true;
          channelsUsed.push("sendblue-imessage-queued");
        } else {
          console.warn(`Sendblue reminder attempt recorded as ${tracked.attempt.state} (${tracked.attempt.attemptId}): ${tracked.result.detail}`);
        }
      } else {
        console.warn("Sendblue reminder not sent: credentials and SENDBLUE_FROM_NUMBER are required.");
      }
    } else if (rem.channel === "slack") {
      const slackToken = state.config.slackBotToken || process.env.SLACK_BOT_TOKEN;
      const slackChannel = rem.recipient || resolveSlackChannel(state);
      deliveryAccepted = false;
      if (slackToken && slackChannel) {
        const result = await postSlackMessage({
          botToken: slackToken,
          channel: slackChannel,
          text: `🔔 *Reminder from Velnor:* ${rem.text} _(${rem.dueAt})_`,
        });
        if (result.ok) {
          deliveryAccepted = true;
          channelsUsed.push("slack-bot");
        } else {
          console.warn(`Slack reminder failed: ${result.detail}`);
        }
      }
    } else if (rem.channel === "sms" && rem.recipient) {
      deliveryAccepted = false;
      const result = await sendTwilioSms({
        accountSid: state.config.twilioAccountSid || "",
        authToken: state.config.twilioAuthToken || "",
        from: state.config.twilioFromNumber || "",
        to: rem.recipient,
        body: `Reminder from Velnor: ${rem.text}`,
      });
      if (result.ok) {
        deliveryAccepted = true;
        channelsUsed.push("twilio-sms");
      } else {
        console.warn(`Twilio SMS reminder failed: ${result.detail}`);
      }
    }

    if (!deliveryAccepted) {
      // Do not append a success-looking feed message or complete the reminder.
      // Release this worker's lease immediately so the next scheduler run can retry.
      releaseReminderDispatch(tenantId, rem.id, workerId);
      continue;
    }

    channelsUsed.push("in-app-feed");
    const msg: ChatMessage = {
      id: `msg-rem-${randomUUID()}`,
      channel: rem.channel,
      sender: "velnor",
      text: alertText,
      timestamp: new Date().toISOString(),
      providerUsed: "scheduler",
      modelUsed: "velnor-proactive-cron",
      toolActions: [{
        tool: "proactive_reminder",
        label: `Queued scheduled reminder (${rem.dueAt})`,
        status: "success",
        details: rem.text,
      }],
    };
    state.messages.push(msg);
    rem.completed = true;
    completedReminderIds.push(rem.id);
    results.push({ reminder: rem, deliveredVia: channelsUsed });
    } catch (error) {
      // Unexpected failures must not strand the durable claim until lease expiry.
      try {
        releaseReminderDispatch(tenantId, rem.id, workerId);
      } catch (releaseError) {
        console.error("Could not release failed reminder dispatch claim:", releaseError);
      }
      console.error("Reminder dispatch failed before completion:", error);
    }
  }

  // Persist only provider-accepted dispatches. Failed external sends remain incomplete;
  // their leases expire and the scheduler can retry them.
  if (completedReminderIds.length > 0) {
    saveStore(state);
    for (const completedId of completedReminderIds) {
      completeReminderDispatch(tenantId, completedId, workerId);
    }
  }
  return results;
}
