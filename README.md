# Olli — Personal AI Assistant for iMessage, SMS & Slack

**Olli** is a full-stack TypeScript / Next.js personal AI assistant modeled after **[olly.bot](https://olly.bot)**, built to live natively inside **Apple iMessage, SMS, and Slack** alongside an interactive web simulator and webhook control center.

## Core Capabilities

1. **Real-Time Web Search & Grounded Q&A**
   - Native Google Search grounding via Gemini (`gemini-3.8-flash`) + live DuckDuckGo / Wikipedia search fallback with clickable source citations.
2. **Document & Link Summarization (In-Memory Vector DB)**
   - Upload PDFs, text files, or paste URLs to extract text, chunk it, compute embeddings (`gemini-embedding-001` + cosine similarity), summarize key insights, and answer grounded questions.
3. **Productivity & Google Workspace Integration**
   - **Gmail Triage**: Read, search, summarize, draft, send, archive, and label emails.
   - **Google Calendar**: Check availability, view schedules, and create calendar events directly via conversational prompts.
   - **Reminders & Tasks**: Schedule text-based reminders across iMessage, SMS, or Slack.
4. **Multimodal Capabilities (Voice & Vision)**
   - **Image Understanding**: Send photos, receipts, or screenshots for analysis.
   - **Image Generation**: Routes visual prompts to Gemini Nano Banana 2 (`gemini-3.1-flash-image`), OpenAI `dall-e-3`, or the built-in SVG visual studio.
   - **Voice Input & Transcription**: Transcribe voice notes via `gemini-3.5-transcribe` and browser speech recognition.
5. **Travel & Local Assistant**
   - Multi-day trip itineraries, verified local landmarks via OpenStreetMap Nominatim, quick translations, and safe flight/hotel booking links.
6. **Multi-Provider AI Router**
   - Switch seamlessly between **Google Gemini (`@google/genai` Interactions API)**, **OpenAI (`gpt-4o`)**, **Anthropic (`claude-3-7-sonnet-latest`)**, or the zero-key **Built-in Smart Orchestrator**.

## Webhook Endpoints

- **Apple iMessage & SMS Webhook**: `POST /api/webhooks/imessage`
  - **Twilio SMS/MMS**: Accepts `application/x-www-form-urlencoded` (`From`, `Body`, `NumMedia`, `MediaUrl0`) and returns valid TwiML XML.
  - **Sendblue**: Accepts JSON (`number`, `content`, `media_url`) and dispatches replies via `https://api.sendblue.co/api/send-message`.
  - **LoopMessage**: Accepts JSON (`recipient`, `text`) and dispatches replies via `https://server.loopmessage.com/api/v1/message/send/`.
- **Slack Bot Webhook**: `POST /api/webhooks/slack`
  - Handles `url_verification`, `event_callback` (`app_mention`, `message.im`), `x-slack-signature` verification, and `/olli` slash commands with Slack Block Kit formatting.

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:3000` to test Olli in the iMessage Simulator, Slack Bot Simulator, and Live Webhook Playground.
