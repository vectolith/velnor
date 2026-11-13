# Velnor — General-Purpose AI Agent Platform by Vectolith

**Velnor** (engineered by **[Vectolith](https://github.com/vectolith)**) is a general-purpose AI agent platform intended to help people across technical and non-technical fields think, learn, create, build, solve problems, and get work done. Engineering and software development are important strengths, not the limits of the product. Velnor combines multi-provider AI routing, grounded information retrieval, multimodal capabilities, integrations, and an evolving model-training programme.

Velnor currently operates through messaging channels and service APIs, including Apple iMessage, SMS, Siri Shortcuts, and Slack. The current repository does not yet provide a general public web-chat frontend; product direction and implemented delivery surfaces are documented separately.

## Product and intelligence objective

Velnor is for **everyone**, including developers, engineers, students, educators, business owners, professionals, creators, and everyday users. Its intelligence roadmap is deliberately broad:

1. **General reasoning and problem solving** — understand goals, ask useful clarifying questions, compare options, explain concepts, and develop practical plans.
2. **Technical intelligence** — programming, software architecture, debugging, testing, cybersecurity fundamentals, mathematics, and scientific reasoning.
3. **Professional and business assistance** — research, writing, analysis, operations, planning, and workflow support.
4. **Learning and education** — tutoring, step-by-step explanations, study support, and adapting explanations to a person's knowledge level.
5. **Creative work** — ideation, drafting, content development, and support for creative production.
6. **Agentic task execution** — decompose requests into steps, select appropriate connected tools, execute only authorised actions, report outcomes, and recover safely from errors.
7. **Context-aware communication** — use relevant permitted context, communicate clearly, and adapt technical depth without stereotyping or excluding users.

The model is one component of this platform, not the whole product. The intended separation is:

- **Intelligence/model:** interprets requests, reasons, plans, and proposes tool calls.
- **Agent runtime:** validates tool schemas, coordinates multi-step work, manages state, handles retries, and reports results.
- **Security and policy core:** authenticates users, enforces tenant isolation and least-privilege permissions, obtains approvals where required, and records auditable actions.

The model must never be treated as the authority for access control. The runtime and security core—not model-generated text—decide whether an action is permitted.

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

## Model training principles and evaluation

Training should improve broadly useful capabilities rather than optimise Velnor exclusively for coding or executive-assistant tasks. The curriculum should grow across general reasoning, instruction following, technical work, education, business and professional workflows, creative tasks, research, multimodal understanding, and safe tool use.

Each capability area needs held-out evaluation tasks. Track task success, factuality and citation quality where relevant, instruction adherence, calibration and uncertainty, tool-selection accuracy, safe refusal, permission-boundary compliance, and regression against the unadapted base model. Compare base and tuned models under the same deterministic evaluation harness. Do not promote a checkpoint based on training loss alone.

Dataset quality, provenance, licensing, privacy, deduplication, contamination checks, and representation across skill levels and user groups are release requirements. Keep high-impact decisions and access-control enforcement outside the model.

**Important status distinction:** this is the product and training objective, not a claim that the current adapter already has general-purpose competence. Consult `training/README.md` and the run reports for the exact model, dataset, hardware, and verified results of each training experiment.

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
