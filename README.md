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

## Running Headless

```bash
npm install
npm run dev
```
