import { getStore, saveStore } from "./store";
import { ChatMessage, ReminderItem } from "./types";

export interface DispatchedReminderResult {
  reminder: ReminderItem;
  deliveredVia: string[];
}

export async function dispatchReminderNotification(
  reminderId?: string
): Promise<DispatchedReminderResult[]> {
  const state = getStore();
  const pending = state.reminders.filter((r) =>
    reminderId ? r.id === reminderId : !r.completed
  );

  const results: DispatchedReminderResult[] = [];

  for (const rem of pending.slice(0, reminderId ? 1 : 3)) {
    const channelsUsed: string[] = ["in-app-feed"];
    const alertText = `🔔 **Olli Reminder:** ${rem.text} _(Scheduled for ${rem.dueAt})_`;

    // 1. Append proactive message to the channel conversation
    const msg: ChatMessage = {
      id: `msg-rem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      channel: rem.channel,
      sender: "olli",
      text: alertText,
      timestamp: new Date().toISOString(),
      providerUsed: "scheduler",
      modelUsed: "olli-proactive-cron",
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
      try {
        await fetch("https://api.sendblue.co/api/send-message", {
          method: "POST",
          headers: {
            "sb-api-key-id": state.config.sendblueApiKey,
            "sb-api-secret-key": state.config.sendblueApiSecret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            number: rem.recipient,
            content: `🔔 Reminder from Olli: ${rem.text}`,
          }),
        });
        channelsUsed.push("sendblue-imessage");
      } catch {
        // Ignore network errors
      }
    }

    // 3. Outbound LoopMessage iMessage dispatch if configured
    if (
      rem.channel === "imessage" &&
      state.config.loopMessageAuthKey &&
      state.config.loopMessageSecretKey &&
      rem.recipient
    ) {
      try {
        await fetch("https://server.loopmessage.com/api/v1/message/send/", {
          method: "POST",
          headers: {
            Authorization: state.config.loopMessageAuthKey,
            "Loop-Secret-Key": state.config.loopMessageSecretKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: rem.recipient,
            text: `🔔 Reminder from Olli: ${rem.text}`,
          }),
        });
        channelsUsed.push("loopmessage-imessage");
      } catch {
        // Ignore
      }
    }

    // 4. Outbound Slack notification if configured
    const slackToken = state.config.slackBotToken || process.env.SLACK_BOT_TOKEN;
    if (rem.channel === "slack" && slackToken) {
      try {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: rem.recipient || "#olli-assistant",
            text: `🔔 *Reminder from Olli:* ${rem.text} _(${rem.dueAt})_`,
          }),
        });
        channelsUsed.push("slack-bot");
      } catch {
        // Ignore
      }
    }

    rem.completed = true;
    results.push({ reminder: rem, deliveredVia: channelsUsed });
  }

  saveStore(state);
  return results;
}
