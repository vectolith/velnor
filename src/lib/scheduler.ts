import { getStore, saveStore, resolveSlackChannel, listUserIds, withVelnorUser } from "./store";
import { sendSendblueMessage } from "./channels/sendblue";
import { sendLoopMessage } from "./channels/loopmessage";
import { postSlackMessage } from "./channels/slack";
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
  const pending = state.reminders.filter((r) =>
    reminderId ? r.id === reminderId : !r.completed
  );

  const results: DispatchedReminderResult[] = [];

  for (const rem of pending.slice(0, reminderId ? 1 : 3)) {
    const channelsUsed: string[] = ["in-app-feed"];
    const alertText = `🔔 **Velnor Reminder:** ${rem.text} _(Scheduled for ${rem.dueAt})_`;

    // 1. Append proactive message to the channel conversation
    const msg: ChatMessage = {
      id: `msg-rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      channel: rem.channel,
      sender: "velnor",
      text: alertText,
      timestamp: new Date().toISOString(),
      providerUsed: "scheduler",
      modelUsed: "velnor-proactive-cron",
      toolActions: [
        {
          tool: "proactive_reminder",
          label: `Triggered scheduled reminder (${rem.dueAt})`,
          status: "success",
          details: rem.text,
        },
      ],
    };
    state.messages.push(msg);

    // 2. Outbound Sendblue iMessage dispatch if configured
    if (
      rem.channel === "imessage" &&
      state.config.sendblueApiKey &&
      state.config.sendblueApiSecret &&
      rem.recipient
    ) {
      const sendblueResult = await sendSendblueMessage({
        apiKeyId: state.config.sendblueApiKey,
        apiSecretKey: state.config.sendblueApiSecret,
        number: rem.recipient,
        fromNumber: state.config.sendblueFromNumber || process.env.SENDBLUE_FROM_NUMBER,
        content: `🔔 Reminder from Velnor: ${rem.text}`,
      });
      if (sendblueResult.ok) channelsUsed.push("sendblue-imessage");
      else console.warn(`Sendblue reminder failed: ${sendblueResult.detail}`);
    }

    // 3. Outbound LoopMessage iMessage dispatch if configured
    if (
      rem.channel === "imessage" &&
      state.config.loopMessageAuthKey &&
      state.config.loopMessageSecretKey &&
      rem.recipient
    ) {
      const loopResult = await sendLoopMessage({
        authKey: state.config.loopMessageAuthKey,
        recipient: rem.recipient,
        text: `🔔 Reminder from Velnor: ${rem.text}`,
      });
      if (loopResult.ok) channelsUsed.push("loopmessage-imessage");
      else console.warn(`LoopMessage reminder failed: ${loopResult.detail}`);
    }

    // 4. Outbound Slack notification if configured
    const slackToken = state.config.slackBotToken || process.env.SLACK_BOT_TOKEN;
    if (rem.channel === "slack" && slackToken) {
      const slackResult = await postSlackMessage({
        botToken: slackToken,
        channel: rem.recipient || resolveSlackChannel(state),
        text: `🔔 *Reminder from Velnor:* ${rem.text} _(${rem.dueAt})_`,
      });
      if (slackResult.ok) channelsUsed.push("slack-bot");
      else console.warn(`Slack reminder failed: ${slackResult.detail}`);
    }

    rem.completed = true;
    results.push({ reminder: rem, deliveredVia: channelsUsed });
  }

  saveStore(state);
  return results;
}
