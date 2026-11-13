# Velnor operations

Everything here matches the code in this repository. Where a step is manual, it says so.

## Where state lives

Per-user state is written by `src/lib/store.ts` to `resolveWritableDataDir()`:

- `<cwd>/.data/velnor.db` when `node:sqlite` is available (Node 22+)
- `<cwd>/.data/users/<userId>.json` as the always-written fallback
- `<cwd>/.data/` in development only when no explicit data directory is configured; production fails closed if no durable writable directory exists

A webhook user id is derived from the provider channel and stable sender identity. Slack identities include both workspace and user IDs. Control-plane requests use a short-lived signed tenant token; caller-provided tenant headers are not accepted.

## Durability, backups and retention

A container filesystem is not durable. On Cloud Run, mount a volume at the data
directory (`/app/.data`) and run with `--min-instances` set so the instance that
holds the volume is the one serving requests; otherwise every cold start begins
from an empty profile. The `Dockerfile` in this repository is the supported build.

Backup: snapshot the `.data` directory (SQLite file plus the JSON mirror). The JSON
mirror exists precisely so a corrupted SQLite file is not the end of a profile.

Retention: nothing in the code deletes old conversations. `messages`, `documents`
and `memories` grow until trimmed by hand, so pick a window (for example 90 days)
and prune `messages` on a schedule, keeping `memories` and `reminders` intact.

Recovery: on load, `store.ts` migrates the payload to the current schema version,
coerces corrupt fields to safe defaults, and if the file cannot be parsed at all it
renames it to `<file>.corrupt-<timestamp>` and starts a clean profile. Nothing is
silently overwritten, so a bad file can always be inspected.

## Secrets

Provider credentials entered through `POST /api/settings` are sealed with AES-256-GCM
(`src/lib/security/secretBox.ts`) before they touch disk, keyed by
`VELNOR_SECRET_KEY` (any string of 16+ characters; it is hashed to a 32-byte key).

- Without `VELNOR_SECRET_KEY`, credentials stay in memory only. Set it before you
  rely on a stored key surviving a restart.
- Rotating the key makes existing sealed values undecryptable. They are dropped on
  read rather than crashing, which means: rotate, then re-enter the provider keys
  once through `POST /api/settings`.
- Required production secrets: `VELNOR_SHARED_SECRET` (control plane),
  `TWILIO_AUTH_TOKEN`, `SLACK_SIGNING_SECRET`, `SENDBLUE_WEBHOOK_SECRET` or
  `LOOPMESSAGE_WEBHOOK_SECRET`, `CRON_SECRET`, `VELNOR_SECRET_KEY`. Missing ones
  fail closed with 503 rather than running open.

## Endpoint exposure

| Endpoint | Auth |
| --- | --- |
| `POST /api/webhooks/imessage` (Twilio form) | `X-Twilio-Signature`, fail closed |
| `POST /api/webhooks/imessage` (Sendblue JSON) | `sb-signing-secret` or configured `x-velnor-webhook-secret` |
| `POST /api/webhooks/imessage` (LoopMessage JSON) | configured `Authorization` webhook header (`LOOPMESSAGE_WEBHOOK_SECRET`) |
| `POST /api/webhooks/slack` | v0 signature + 300s freshness |
| `GET/POST /api/chat`, `GET/POST /api/settings`, `POST /api/siri` | signed tenant bearer token; shared deployment secret is an outer gate where enabled |
| `POST /api/tts` | signed tenant bearer token + shared deployment gate |
| `GET/POST /api/lora-pilot` | `VELNOR_SHARED_SECRET` |
| `/api/cron/*` | `Authorization: Bearer $CRON_SECRET` |
| `GET /api/health`, `GET /api/webhooks/manifest` | public |
| `POST /api/internal/tenants/provision` | `x-velnor-provisioning-secret` (identity gateway only) |

`VELNOR_ALLOW_SIMULATOR=1` plus `NODE_ENV !== "production"` is the only way the
`x-velnor-simulator` header can skip signatures. Never enable the simulator bypass in production.

## Audit logging and monitoring

The service logs to stdout: middleware rejections (401/429/503), quarantined state
files, sealed-credential drops after a key change, Gmail send failures, and
provider fallbacks. There is no structured logger or request id yet, so treat the
current logs as operational breadcrumbs, not an audit trail.

What to watch: 401/503 rates on webhooks (a spike means a misconfigured provider
secret), 429 volume per IP (abuse or a retry storm), and agent fallbacks to the
heuristic orchestrator (means provider keys are missing or exhausted).

## Rate limiting

`src/middleware.ts` allows 90 requests per minute per IP using an in-process map.
Behind more than one instance the effective limit multiplies by the instance count,
and it is per IP rather than per sender. If that matters, put a shared store in
front (Redis/Upstash) or terminate rate limiting at the platform edge.

## CI

`.github/workflows/ci.yml` runs `npm ci`, `npm test`, `npm run typecheck`,
`npm run build`, and `scripts/verify-velnor.mjs` against a booted production server.
The repository's current workflow is the source of truth; no manual patch is needed.

## Deploying

`deploy/cloudrun/deploy-cloudrun.ps1` runs `scripts/preflight-deploy.mjs` first and refuses to
continue when a required secret is missing, because Velnor fails closed: a deploy
without `VELNOR_SHARED_SECRET` produces a service that answers 503 everywhere and
looks broken rather than unsecured. Pass `-DataVolume <bucket>` to mount Cloud
Storage at `/app/.data`; without a mount, chats, reminders and sealed credentials
die with the container revision.

Preflight checks: `VELNOR_SHARED_SECRET`, `VELNOR_SECRET_KEY` (32+ characters),
`VELNOR_TENANT_TOKEN_SECRET` (32+ characters), `VELNOR_PROVISIONING_SECRET` (32+ characters), and `CRON_SECRET` are required;
`VELNOR_DATA_DIR`, `TWILIO_AUTH_TOKEN`,
`SLACK_SIGNING_SECRET` and `SENDBLUE_WEBHOOK_SECRET` warn when absent;
`VELNOR_EMAIL_ALLOWLIST` is rejected if an entry is not an address or @domain.

Run it locally before any rollout:

```
VELNOR_SHARED_SECRET=... VELNOR_SECRET_KEY=... VELNOR_TENANT_TOKEN_SECRET=... VELNOR_PROVISIONING_SECRET=... CRON_SECRET=... node scripts/preflight-deploy.mjs
```

## Where things run

Production is a single Oracle Cloud VM (`deploy/oci/`), documented in
`deploy/oci/README.md`. `deploy/cloudrun/` is the Cloud Run alternative, kept for as
long as it works; it is not the deployment of record. `deploy/vercel/vercel.json` is
parked the same way: its `crons` block was the only thing firing
`/api/cron/reminders`, so on the VM that job belongs to `velnor-reminders.timer`,
which `deploy/oci/setup-vm.sh` installs. If you deploy anywhere else, wire that route
to a scheduler first or reminders will never be delivered.
