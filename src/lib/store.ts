import fs from "fs";
import path from "path";
import { loadStateFromSqlite, saveStateToSqlite } from "./sqliteDb";
import {
  CalendarEventItem,
  ChatMessage,
  DocumentChunk,
  EmailItem,
  IndexedDocument,
  ProviderConfig,
  ReminderItem,
} from "./types";

export interface OlliState {
  messages: ChatMessage[];
  reminders: ReminderItem[];
  calendarEvents: CalendarEventItem[];
  emails: EmailItem[];
  documents: IndexedDocument[];
  documentChunks: DocumentChunk[];
  config: ProviderConfig;
  conversationCursors: Record<string, string>; // channelKey -> last Gemini interactionId
}

const DATA_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(DATA_DIR, "olli-store.json");

const DEFAULT_STATE: OlliState = {
  messages: [
    {
      id: "welcome-imessage",
      channel: "imessage",
      sender: "olli",
      text: "Hey! I'm Olli 👋 Your personal AI assistant right inside iMessage, SMS & Slack.\n\nYou can text me to:\n• Search the live web & get cited answers\n• Summarize PDFs, docs, or links (chat with your files)\n• Read, draft, or send Gmail messages & manage Google Calendar\n• Set reminders & tasks\n• Analyze photos, generate images, or transcribe voice notes\n• Plan travel itineraries, find local spots & translate on the go",
      timestamp: new Date().toISOString(),
      providerUsed: "system",
      modelUsed: "gemini-3.8-flash",
    },
    {
      id: "welcome-slack",
      channel: "slack",
      sender: "olli",
      text: "👋 *Olli Bot is online in `#olli-assistant`!* Mention `@Olli` or use `/olli` to search the web, summarize docs, triage Gmail & Calendar, generate visuals, or plan trips.",
      timestamp: new Date().toISOString(),
      providerUsed: "system",
      modelUsed: "gemini-3.8-flash",
    },
  ],
  reminders: [
    {
      id: "rem-1",
      text: "Follow up with Sarah on the Q4 product roadmap deck",
      dueAt: "Today at 4:30 PM",
      channel: "imessage",
      recipient: "+1 (555) 019-2834",
      completed: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: "rem-2",
      text: "Check in for flight to Tokyo (NH 105)",
      dueAt: "Tomorrow at 9:00 AM",
      channel: "slack",
      recipient: "@you",
      completed: false,
      createdAt: new Date().toISOString(),
    },
  ],
  calendarEvents: [
    {
      id: "evt-1",
      title: "Product Design Sync",
      date: new Date().toISOString().split("T")[0],
      startTime: "10:30",
      endTime: "11:15",
      attendees: ["sarah@acme.io", "marcus@acme.io"],
      location: "Google Meet",
      description: "Review mobile messaging UX and webhook latency metrics.",
      source: "google_calendar",
    },
    {
      id: "evt-2",
      title: "Founder Coffee w/ David",
      date: new Date().toISOString().split("T")[0],
      startTime: "14:00",
      endTime: "15:00",
      attendees: ["david@sequoia.example.com"],
      location: "Blue Bottle Coffee, SOMA",
      description: "Catch up on seed extension & AI agent benchmarks.",
      source: "google_calendar",
    },
  ],
  emails: [
    {
      id: "em-1",
      from: "Sarah Jenkins <sarah@acme.io>",
      to: "you@olli.bot",
      subject: "Q4 Architecture Review & Launch Checklist",
      snippet: "Hey! Attached the latest metrics for the iMessage + Slack rollout. Can we confirm the webhook rate limits before Thursday?",
      body: "Hey!\n\nAttached the latest metrics for the iMessage + Slack rollout. Can we confirm the webhook rate limits before Thursday's engineering all-hands? Also let me know if you want to move our 10:30 sync.\n\nBest,\nSarah",
      date: "10:14 AM",
      unread: true,
      archived: false,
      labels: ["Important", "Work"],
      status: "inbox",
    },
    {
      id: "em-2",
      from: "ANA Mileage Club <flights@ana.co.jp>",
      to: "you@olli.bot",
      subject: "Booking Confirmation: SFO to HND (Tokyo Haneda)",
      snippet: "Your reservation is confirmed. Flight NH 105 departing at 12:50 PM, Seat 6A. Hotel: Hoshinoya Tokyo.",
      body: "Dear Traveler,\n\nYour reservation is confirmed!\nFlight: ANA NH 105 (SFO -> HND)\nDeparture: 12:50 PM | Seat: 6A\nConfirmation Code: OLLI9X\nHotel Reference: Hoshinoya Tokyo (Otemachi, Chiyoda-ku)\n\nSafe travels!",
      date: "Yesterday",
      unread: true,
      archived: false,
      labels: ["Travel", "Flights"],
      status: "inbox",
    },
    {
      id: "em-3",
      from: "Marcus Vance <marcus@acme.io>",
      to: "you@olli.bot",
      subject: "Twilio & LoopMessage throughput report",
      snippet: "P95 latency dropped to 410ms after switching to Gemini 3.8 Flash.",
      body: "Hi team,\n\nJust sharing the weekly report: P95 webhook latency dropped to 410ms after switching to Gemini 3.8 Flash and caching vector embeddings in-memory.\n\nCheers,\nMarcus",
      date: "Nov 6",
      unread: false,
      archived: false,
      labels: ["Engineering"],
      status: "inbox",
    },
  ],
  documents: [
    {
      id: "doc-seed-1",
      name: "Olli_Product_Brief_2026.pdf",
      sourceType: "file",
      summary: "Product specification for Olli: an omnichannel personal AI assistant native to iMessage, SMS, and Slack with in-memory HNSW vector search, Google Workspace OAuth, and multi-provider LLM routing.",
      chunkCount: 3,
      wordCount: 165,
      createdAt: new Date().toISOString(),
    },
  ],
  documentChunks: [
    {
      id: "chk-1",
      docId: "doc-seed-1",
      docName: "Olli_Product_Brief_2026.pdf",
      content: "Olli is a privacy-first personal AI assistant that lives natively inside messaging apps including Apple iMessage, SMS (via Twilio, Sendblue, and LoopMessage), and Slack.",
      tokens: ["olli", "privacy", "first", "personal", "ai", "assistant", "messaging", "apple", "imessage", "sms", "twilio", "sendblue", "loopmessage", "slack"],
    },
    {
      id: "chk-2",
      docId: "doc-seed-1",
      docName: "Olli_Product_Brief_2026.pdf",
      content: "For document intelligence, Olli uses an in-memory vector store with cosine similarity and Gemini embeddings to answer questions about uploaded PDFs, articles, and URLs with zero external configuration.",
      tokens: ["document", "intelligence", "vector", "store", "cosine", "similarity", "gemini", "embeddings", "pdfs", "articles", "urls"],
    },
    {
      id: "chk-3",
      docId: "doc-seed-1",
      docName: "Olli_Product_Brief_2026.pdf",
      content: "Productivity features include Gmail triage (reading, searching, summarizing, drafting, sending, and archiving emails), Google Calendar scheduling, smart text reminders, and travel itinerary planning.",
      tokens: ["productivity", "gmail", "triage", "emails", "google", "calendar", "scheduling", "reminders", "travel", "itinerary", "planning"],
    },
  ],
  config: {
    activeProvider: "auto",
    geminiModel: "gemini-3.8-flash",
    geminiImageModel: "gemini-3.1-flash-image",
    openaiModel: "gpt-4o",
    anthropicModel: "claude-3-7-sonnet-latest",
  },
  conversationCursors: {},
};

declare global {
  // eslint-disable-next-line no-var
  var __olliMemoryState: OlliState | undefined;
}

export function getStore(): OlliState {
  if (global.__olliMemoryState) {
    return global.__olliMemoryState;
  }
  const sqliteLoaded = loadStateFromSqlite();
  if (sqliteLoaded) {
    global.__olliMemoryState = {
      ...DEFAULT_STATE,
      ...sqliteLoaded,
      config: { ...DEFAULT_STATE.config, ...(sqliteLoaded.config || {}) },
    };
    return global.__olliMemoryState;
  }
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as OlliState;
      global.__olliMemoryState = {
        ...DEFAULT_STATE,
        ...parsed,
        config: { ...DEFAULT_STATE.config, ...(parsed.config || {}) },
      };
      saveStateToSqlite(global.__olliMemoryState);
      return global.__olliMemoryState;
    }
  } catch (err) {
    console.warn("Could not read store from disk, using in-memory default:", err);
  }
  global.__olliMemoryState = structuredClone(DEFAULT_STATE);
  saveStore(global.__olliMemoryState);
  return global.__olliMemoryState;
}

export function saveStore(state: OlliState): void {
  global.__olliMemoryState = state;
  saveStateToSqlite(state);
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("Non-fatal: could not persist store to disk:", err);
  }
}

export function getEffectiveKeys(state: OlliState) {
  return {
    geminiApiKey: state.config.geminiApiKey || process.env.GEMINI_API_KEY || "",
    openaiApiKey: state.config.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: state.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
  };
}

