#!/usr/bin/env bash
# One reminder sweep, invoked by velnor-reminders.timer.
#
# /api/cron/reminders is gated in middleware on `Authorization: Bearer $CRON_SECRET`
# and fails closed with 503 when CRON_SECRET is unset, so the secret is read from
# .env here rather than being baked into the unit file where `systemctl cat` would
# print it to anyone with read access.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
secret="$(grep -E '^CRON_SECRET=' "$here/.env" 2>/dev/null | cut -d= -f2- || true)"

if [[ -z "$secret" ]]; then
  echo "CRON_SECRET is not set in $here/.env; refusing to sweep" >&2
  exit 1
fi

curl -fsS --max-time 120 -H "Authorization: Bearer ${secret}" \
  http://127.0.0.1:8080/api/cron/reminders
