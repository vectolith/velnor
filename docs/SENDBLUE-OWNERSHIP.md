# Sendblue ownership

Sendblue is BLUD's iMessage transport. It is configured, deployed and operated with
BLUD:

- Channel: `agent/channels/sendblue.ts` in the BLUD repository.
- Credentials: `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`,
  `SENDBLUE_WEBHOOK_SECRET`, all in the BLUD deployment environment.
- Webhook URL to register with Sendblue: `https://<blud-host>/sendblue/webhook?secret=<SENDBLUE_WEBHOOK_SECRET>`.

VELNOR does not need Sendblue credentials to run: its iMessage path is LoopMessage and
its SMS path is Twilio. A VELNOR deployment that leaves Sendblue unset behaves exactly as
before, and BLUD no longer shares a provider account with it.
