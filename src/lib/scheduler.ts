import { randomUUID } from "node:crypto";
import { getStore, saveStore, resolveSlackChannel, listUserIds, withVelnorUser, currentUserId } from "./store";
import { claimReminderDispatch, completeReminderDispatch } from "./sqliteDb";
import { sendSendblueMessage } from "./channels/sendblue";
import { sendLoopMessage } from "./channels/loopmessage";
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

    const channelsUsed: string[] = [];
    const alertText = `🔔 **Velnor Reminder:** ${rem.text} _(Scheduled for ${rem.dueAt})_`;
    const outboundConfigured = Boolean(rem.recipient) && (
      (rem.channel === "imessage" && Boolean(
        (state.config.sendblueApiKey && state.config.sendblueApiSecret) ||
        state.config.loopMessageAuthKey
      )) ||
      (rem.channel === "slack" && Boolean(state.config.slackBotToken || process.env.SLACK_BOT_TOKEN)) ||
      (rem.channel === "sms" && Boolean(
        state.config.twilioAccountSid && state.config.twilioAuthToken && state.config.twilioFromNumber
      ))
    );
    let deliveryAccepted = !rem.recipient || !outboundConfigured;

    if (rem.channel === "imessage" && rem.recipient) {
      deliveryAccepted = false;
      if (state.config.sendblueApiKey && state.config.sendblueApiSecret) {
        const result = await sendSendblueMessage({
          apiKeyId: state.config.sendblueApiKey,
          apiSecretKey: state.config.sendblueApiSecret,
          number: rem.recipient,
          fromNumber: state.config.sendblueFromNumber || process.env.SENDBLUE_FROM_NUMBER,
          content: `🔔 Reminder from Velnor: ${rem.text}`,
        });
        if (result.ok) {
          deliveryAccepted = true;
          channelsUsed.push("sendblue-imessage");
        } else {
          console.warn(`Sendblue reminder failed: ${result.detail}`);
        }
      }
      if (state.config.loopMessageAuthKey) {
        const result = await sendLoopMessage({
          authKey: state.config.loopMessageAuthKey,
          recipient: rem.recipient,
          text: `🔔 Reminder from Velnor: ${rem.text}`,
        });
        if (result.ok) {
          deliveryAccepted = true;
          channelsUsed.push("loopmessage-imessage");
        } else {
          console.warn(`LoopMessage reminder failed: ${result.detail}`);
        }
      }
    } else if (rem.channel === "slack" && rem.recipient) {
      const slackToken = state.config.slackBotToken || process.env.SLACK_BOT_TOKEN;
      deliveryAccepted = false;
      if (slackToken) {
        const result = await postSlackMessage({
          botToken: slackToken,
          channel: rem.recipient || resolveSlackChannel(state),
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
      // Its lease expires, allowing the next scheduler run to retry it.
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
