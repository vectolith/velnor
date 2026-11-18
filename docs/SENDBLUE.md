# Sendblue iMessage channel

VELNOR sends and receives iMessage through Sendblue. This document covers
production setup, what the code guarantees, and how to prove it is working.

## 1. Prerequisites

- A Sendblue account with an approved iMessage line. Lines are provisioned per
  account; the line must be **allowed to send** (Sandbox/test lines often are
  not, and Sendblue then returns an error instead of queuing).
- The line's E.164 number, e.g. `+18083199759`.
- API credentials from **Dashboard → Settings → API**.

## 2. Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `SENDBLUE_API_KEY` | yes | Sendblue API key ID. |
| `SENDBLUE_API_SECRET` | yes | Sendblue API secret. Never expose to the browser. |
| `SENDBLUE_FROM_NUMBER` | yes | E.164 line used as the sender. Normalized on load. |
| `SENDBLUE_WEBHOOK_SECRET` | yes in production | Shared secret the webhook must present. 32+ random chars. |
| `VELNOR_PUBLIC_URL` | yes in production | Canonical HTTPS origin, e.g. `https://velnor.app`. |

Workspace settings (`sendblueApiKey`, `sendblueApiSecret`, `sendblueFromNumber`,
`sendblueWebhookSecret`) take precedence over the environment, so one
deployment can serve multiple workspaces with different lines.

Generate a secret with:

```bash
openssl rand -hex 32
```

## 3. Webhook

In **Sendblue → Settings → Webhooks** create one webhook:

- URL: `https://YOUR-VELNOR-DOMAIN/api/webhooks/imessage`
- Signing secret / header value: the same value as `SENDBLUE_WEBHOOK_SECRET`
- Events: inbound messages and outbound status updates

Sendblue posts JSON with the secret in the `sb-signing-secret` header (the
`x-velnor-webhook-secret` header is also accepted for local testing). In
production a missing or mismatched secret is rejected with 401, and a missing
configured secret fails closed with 503 — the webhook never runs unauthenticated.

## 4. What the code guarantees

- **Durable attempt ledger.** A row is written before every provider call. A
  timeout, 5xx, or a 2xx without a `message_handle` becomes `unconfirmed`, not
  "sent". Nothing is ever reported delivered on the strength of a queued send.
- **Explicit refusals are final.** A 4xx or an error payload marks the attempt
  `failed`; retries are safe and do not duplicate.
- **Delivery receipts are tracked.** Outbound status callbacks update the
  attempt. A receipt that arrives before the handle is stored is buffered and
  replayed, and a late `ERROR` can never move a `delivered` message backwards.
- **No reply loops.** Messages from VELNOR's own line and outbound echoes are
  never treated as inbound.
- **Durable inbound dedupe.** Provider retries are dropped by
  `(provider, message_handle)` across restarts and instances, so one message
  never bills two agent runs. A failed turn releases the claim so the provider
  retry is processed.
- **Long replies are split** into carrier-safe parts, each tracked separately.
- **Failures still answer.** If the agent throws, the customer receives a short
  apology instead of silence.

## 5. Health check

`GET /api/health` is the public liveness probe and exposes nothing about
channels. `GET /api/health/channels` returns `200` when at least one iMessage
channel is ready and `503` otherwise. Set `VELNOR_HEALTH_SECRET` and send it as
`x-velnor-health-secret` to receive the configuration issue list; no secret
value is ever echoed.

```json
{
  "status": "ok",
  "storage": "ok",
  "channels": { "sendblue": "ready", "loopmessage": "ready" },
  "time": "2026-11-17T00:00:00.000Z"
}
```

Point an uptime monitor at it.

## 6. Verifying a deployment

1. `curl -s https://YOUR-DOMAIN/api/health | jq` → `status: ok`.
2. Send an iMessage from your phone to the Sendblue line.
3. Confirm a reply arrives and the server log shows
   `iMessage JSON webhook processed` with `provider: "sendblue"`.
4. Check the attempt row: `queued` at send time, then `delivered` when the
   receipt lands.
5. Force an error (wrong API key) and confirm the attempt is `failed` with the
   provider message, not a silent success.

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `error_message` mentioning the from number | Line cannot send | Provision/unblock the line in Sendblue. |
| Webhook returns 401 | Secret mismatch | Copy the dashboard signing secret into `SENDBLUE_WEBHOOK_SECRET`. |
| Webhook returns 503 | Secret not configured in production | Set the variable and redeploy. |
| Inbound works, no outbound | Missing key, secret, or line | Check `/api/health` issues. |
| Duplicate replies | Two channels configured | Configure one provider per workspace. |
| `unconfirmed` attempts | Timeout or 5xx | Safe to retry; the ledger warns about duplicate risk. |

## 8. Security notes

- Secrets live only in server-side env or the tenant record; never in client
  bundles or logs.
- Webhook comparisons are constant time.
- Payloads are capped at 1 MB and message text at 8,000 characters.
- The simulator header only works outside production and only with
  `VELNOR_ALLOW_SIMULATOR=1`.
