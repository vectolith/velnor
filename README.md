# Velnor — Headless Personal AI Assistant for iMessage, SMS, Siri & Slack

**Velnor** is a headless, messaging-only personal AI assistant powered by the fine-tuned **`velnor-core-v1`** model and multi-provider AI routing. It operates strictly through native messaging channels (**Apple iMessage, SMS, Siri Shortcuts, and Slack**) with no web chat UI or frontend application.

## Core Capabilities

1. **Real-Time Web Search & Grounded Q&A**
   - Native Google Search grounding via Gemini + live DuckDuckGo / Wikipedia search fallback with source citations.
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
5. **Travel & Local Assistant**
   - Multi-day trip itineraries, verified local landmarks via OpenStreetMap Nominatim, quick translations, and flight/hotel booking links.
6. **Fine-Tuned `velnor-core-v1` LoRA Adapter & Multi-Provider Router**
   - Includes a dedicated local PyTorch/PEFT LoRA inference daemon (`training/serve_adapter.py` serving `velnor-core-v1` on port `8099`) alongside Gemini, OpenAI, and Anthropic routing.

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
