# Velnor engineering review — core fixes

Reviewed the headless assistant end to end (webhooks, agent, tools, storage,
training). This branch fixes the issues that blocked it from working as an
assistant rather than as a demo.

## Fixed in this branch

1. **Auth on state-mutating endpoints.** `/api/chat`, `/api/siri`,
   `/api/settings` and `/api/lora-pilot` were open to the internet. They now
   require `VELNOR_SHARED_SECRET` (Bearer or `x-velnor-secret`) and answer 503
   in production if the secret is unset. `x-velnor-simulator` only works when
   `VELNOR_ALLOW_SIMULATOR=1`.
2. **Channel-safe output.** Added `src/lib/format.ts` (`toPlainText`,
   `splitForSms`) and wired it into the iMessage/SMS webhook: markdown markers
   and emoji-heading noise no longer reach the carrier, and long replies are
   split instead of dropped.
3. **Local 135M LoRA is opt-in.** It used to intercept any message containing
   "code", "sql", "function" or "api key" before a real model ran. Its own
   `training/pilot_report.json` sample generations are incoherent, so it now
   requires `VELNOR_LOCAL_LORA=1`.
4. **No more canned demo data.** Removed the seeded fake emails, calendar
   events, reminders, documents and "Sarah Jenkins / acme.io" memories from the
   default state, and removed the hardcoded `sarah@acme.io` / `team@acme.io`
   recipients from the fallback orchestrator. Missing recipients now produce an
   honest request for the address.
5. **Honest image handling.** The fallback no longer claims to have "inspected"
   an image when no vision model is configured.

## Still open (bigger work, not in this branch)

- Only the OpenAI path runs a real tool loop; Gemini and Anthropic need the
  same loop so tool declarations are honoured everywhere.
- Storage is a single global JSON/SQLite file — needs Postgres and per-user
  tenancy before multi-user use, since serverless filesystems are ephemeral.
- Web search is DuckDuckGo Instant Answers + Wikipedia + HN, not Google
  grounding, and never fetches result pages.
- `scripts/verify-velnor.mjs` asserts on strings the code emits, so it cannot
  catch regressions; replace with real integration tests.
- The Antigravity workflow executes JS fetched from a third-party host inside
  Actions with repo secrets in env. Pin to a hash and review, or drop it.

## Verify

```bash
npm ci
npx tsc --noEmit
npm run build
VELNOR_SHARED_SECRET=test123 next start -p 3199
curl -s -o /dev/null -w '%{http_code}\n' localhost:3199/api/chat                     # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer test123' localhost:3199/api/chat  # 200
```
