import { randomUUID } from "node:crypto";
import { getStore, saveStore, resolveSlackChannel, listUserIds, withVelnorUser, currentUserId } from "./store";
import { claimReminderDispatch, completeReminderDispatch, releaseReminderDispatch } from "./sqliteDb";
import { sendTrackedSendblueMessage } from "./channels/trackedSendblueSend";
import { resolveSendblueConfig } from "./channels/sendblueConfig";
import { sendTrackedLoopMessage } from "./channels/trackedLoopMessageSend";
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
      const sendblue = resolveSendblueConfig(state.config as unknown as Record<string, unknown>);
      if (sendblue.configured) {
        // Reminders use the same durable attempt ledger as task replies, so a
        // timeout or crash leaves a retryable record instead of a lost reminder.
        const tracked = await sendTrackedSendblueMessage({
          tenantId,
          taskId: "reminder_" + rem.id,
          recipient: rem.recipient,
          senderId: sendblue.config.fromNumber,
          config: {
            apiKeyId: sendblue.config.apiKeyId,
            apiSecret: sendblue.config.apiSecret,
            fromNumber: sendblue.config.fromNumber,
          },
          text: `🔔 Reminder from Velnor: ${rem.text}`,
        });
        if (!tracked.result.ok) {
          console.warn(`Sendblue reminder attempt recorded as ${tracked.attempt.state} (${tracked.attempt.attemptId}): ${tracked.result.detail}`);
        }
        if (tracked.result.ok) {
          deliveryAccepted = true;
          channelsUsed.push("sendblue-imessage");
        }
      }
      if (state.config.loopMessageAuthKey) {
        // Reminders get the same durable attempt ledger as tasks so a reminder
        // that fails without a provider message ID is not silently lost.
        const tracked = await sendTrackedLoopMessage({
          authKey: state.config.loopMessageAuthKey,
          recipient: rem.recipient,
          text: `🔔 Reminder from Velnor: ${rem.text}`,
          senderId: process.env.LOOPMESSAGE_SENDER_ID || "",
          tenantId,
          taskId: "reminder_" + rem.id,
        });
        const result = tracked.result;
        if (!result.ok) {
          console.warn(`LoopMessage reminder attempt recorded as ${tracked.attempt.state} (${tracked.attempt.attemptId})`);
        }
        if (result.ok) {
          deliveryAccepted = true;
          channelsUsed.push("loopmessage-imessage");
        } else {
          console.warn(`LoopMessage reminder failed: ${result.detail}`);
        }
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
        label: `Delivered scheduled reminder (${rem.dueAt})`,
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

  // Persist only accepted deliveries. Failed external sends remain incomplete;
  // their leases expire and the scheduler can retry them.
  if (completedReminderIds.length > 0) {
    saveStore(state);
    for (const completedId of completedReminderIds) {
      completeReminderDispatch(tenantId, completedId, workerId);
    }
  }
  return results;
}
