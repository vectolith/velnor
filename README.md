# Velnor — Headless Personal AI Agent by Vectolith

**Velnor** (engineered by **[Vectolith](https://github.com/vectolith)**) is a headless, messaging-only executive AI agent powered by the fine-tuned **`velnor-core-v1`** rsLoRA model (12-domain executive intelligence curriculum) and multi-provider AI routing. It operates strictly through native messaging channels (**Apple iMessage, SMS, Siri Shortcuts, and Slack**) with no web chat UI or frontend application.

## Core Capabilities

1. **Real-Time Web Search & Grounded Q&A**
   - Searches DuckDuckGo's HTML index, then fetches and reads the top pages (article extraction, 5-minute cache) so answers are grounded in page text, not search snippets. Wikipedia and Hacker News supplement the result set.
2. **Document & Link Summarization (In-Memory Vector DB)**
   - Extract text from PDFs, text attachments, or URLs, chunk and embed (`gemini-embedding-001` + cosine similarity), and answer grounded questions over messaging.
3. **Productivity & Google Workspace Integration**
   - **Gmail Triage**: Read, search, summarize, draft, send, archive, and label emails.
   - **Google Calendar**: Check availability, view schedules, and create calendar events directly via iMessage, SMS, Siri, or Slack.
   - **Reminders & Tasks**: Schedule text-based reminders across iMessage, SMS, or Slack.
4. **Multimodal Capabilities (Voice & Vision)**
   - **Image Understanding**: Send MMS/iMessage photos, receipts, or screenshots for analysis.
   - **Image Generation**: Generate visuals via Gemini, OpenAI, or the built-in SVG engine.
   - **Voice & Siri**: Hands-free voice invocation via `/api/siri` and `/api/tts`.
5. **Travel & Local Agent**
   - Multi-day trip itineraries, verified local landmarks via OpenStreetMap Nominatim, quick translations, and flight/hotel booking links.
6. **One Agent Loop, Every Provider**
   - Gemini, OpenAI and Anthropic all run through the same tool-calling loop (`src/lib/ai/loop.ts`), so every declared tool works on every model. Providers are tried in order with timeouts, bounded retries on 429/5xx, and per-request token/cost accounting surfaced on `/api/health`.
   - The local PyTorch/PEFT LoRA daemon (`training/serve_adapter.py`, port `8099`) is opt-in via `VELNOR_LOCAL_LORA=1`; it never silently answers a real request.
7. **Per-User Tenancy**
   - Every channel handle gets its own state (messages, reminders, memories, documents, usage), persisted per tenant in SQLite and `.data/users/<id>.json`. Requests are scoped with `withVelnorUser()`; no cross-tenant reads.

## Headless Webhook & API Endpoints

- **Root Status**: `GET /` — Returns headless service status and active webhook URLs.
- **Apple iMessage & SMS Webhook**: `POST /api/webhooks/imessage`
  - **Twilio SMS/MMS**: Accepts `application/x-www-form-urlencoded` (`From`, `Body`, `NumMedia`, `MediaUrl0`) and returns valid TwiML XML.
  - **Sendblue**: Accepts JSON (`number`, `content`, `media_url`) and dispatches replies via `https://api.sendblue.co/api/send-message`.
  - **LoopMessage**: Accepts JSON (`recipient`, `text`) and dispatches replies via `https://server.loopmessage.com/api/v1/message/send/`.
- **Slack Bot Webhook**: `POST /api/webhooks/slack`
  - Handles `url_verification`, `event_callback` (`app_mention`, `message.im`), `x-slack-signature` verification, and `/velnor` slash commands with Slack Block Kit formatting.
- **Apple Siri / Shortcuts Endpoint**: `GET, POST /api/siri`
- **LoRA Pilot Endpoint**: `GET, POST /api/lora-pilot`
- **Contact Card (vCard)**: `GET /api/vcard`
- **Health Check**: `GET /api/health`

## Creating the Slack app

The repository serves a complete Slack app manifest from
`GET /api/webhooks/manifest?only=manifest&baseUrl=https://your-deployment`, which is
paste-ready for [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* →
*From an app manifest*. It carries the bot scopes the code actually calls, the two
events the agent handles (`app_mention`, `message.im`), and a `/velnor` slash command,
all pointed at `/api/webhooks/slack` on that base URL.

After Slack issues the app:

1. Install it to the workspace and copy the `xoxb-` bot token into `slackBotToken`
   via `POST /api/settings` (or `SLACK_BOT_TOKEN`).
2. Copy the signing secret into `slackSigningSecret` (or `SLACK_SIGNING_SECRET`), which
   the webhook verifies before it will answer.
3. Put the app in the channel you want replies in, and either name that channel
   `#velnor-agent` or set `slackChannel` in settings (or `SLACK_CHANNEL` on the
   deployment) to it. A channel id such as `C0CFWLMSP9V` is preferable there,
   because a channel rename would not break it.

That paste step can be scripted instead, once you have an app configuration token:

```bash
SLACK_CONFIG_TOKEN=xoxe-... node --import tsx scripts/create-slack-app.mjs \
  --base-url https://your-deployment
```

It validates the manifest against Slack, creates the app, and prints the install
URL. Add `--dry-run` to see the manifest it would send, or `--validate-only` to check
it without creating anything. Slack calls the request URL during creation, so the
base URL has to be the live deployment.

Creating the app itself needs either that paste step or an app configuration token
(api.slack.com/apps → *Your App Configuration Tokens*) for `apps.manifest.create`;
an ordinary user or bot token cannot create apps.

## Running Headless

```bash
npm install
npm run dev
```

## Repository layout

```
src/app/            Next.js routes: chat, settings, health, webhooks, cron
src/lib/            agent loop, store and state sealing, channels, tools
tests/              unit, E2E and deployment-contract suites
scripts/            operator tools: preflight, Slack app manifest, verify suite
deploy/oci/         production: compose stack, Caddyfile, VM setup, reminder timer
deploy/cloudrun/    alternative: PowerShell deploy script for Cloud Run
deploy/vercel/      parked cron config from the Vercel era
docs/               operations runbook, engineering review, maintainer patches
training/           LoRA training and evaluation scripts (not part of the service)
public/             static assets served by the app
```

`deploy/oci/docker-compose.yml` is the only deployment that runs in production today.

## Brand assets

`public/brand/velnor-icon.svg` is the mark on its own, transparent and monochrome; it
follows `prefers-color-scheme` the way `vectolith-icon.svg` does, so it inverts rather
than needing two files. `public/brand/velnor-logo.svg` is the same mark on the
obsidian tile for app icons and avatars. Both are hand-authored SVG: no raster
master, nothing to regenerate at size.

The form follows `vectolith/vectolith`'s drafting language exactly: a 500 grid, facets
stroked at width 20 with round joins, two colours, and the same
`prefers-color-scheme` swap so one file serves both themes. It is deliberately not the
same monument: where Vectolith is a static hexagonal prism with a spine, Velnor is a
rotor, six twisted blades turning around a diamond void with indexing struts outside.
Circulation rather than monolith.
