import fs from "fs";
import path from "path";
import { loadStateFromSqlite, resolveWritableDataDir, saveStateToSqlite } from "./sqliteDb";
import {
  CalendarEventItem,
  ChatMessage,
  DocumentChunk,
  EmailItem,
  IndexedDocument,
  MemoryFact,
  ProviderConfig,
  ReminderItem,
} from "./types";

export interface VelnorState {
  messages: ChatMessage[];
  reminders: ReminderItem[];
  calendarEvents: CalendarEventItem[];
  emails: EmailItem[];
  documents: IndexedDocument[];
  documentChunks: DocumentChunk[];
  memories: MemoryFact[];
  config: ProviderConfig;
  conversationCursors: Record<string, string>; // channelKey -> last Gemini interactionId
}

const DATA_DIR = resolveWritableDataDir();
const STORE_PATH = path.join(DATA_DIR, "velnor-store.json");

const DEFAULT_STATE: VelnorState = {
  messages: [],
  reminders: [],
  calendarEvents: [],
  emails: [],
  documents: [],
  documentChunks: [],
  memories: [],
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
  var __velnorMemoryState: VelnorState | undefined;
}

export function getStore(): VelnorState {
  if (global.__velnorMemoryState) {
    return global.__velnorMemoryState;
  }
  const sqliteLoaded = loadStateFromSqlite();
  if (sqliteLoaded) {
    global.__velnorMemoryState = {
      ...DEFAULT_STATE,
      ...sqliteLoaded,
      config: { ...DEFAULT_STATE.config, ...(sqliteLoaded.config || {}) },
    };
    return global.__velnorMemoryState;
  }
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as VelnorState;
      global.__velnorMemoryState = {
        ...DEFAULT_STATE,
        ...parsed,
        config: { ...DEFAULT_STATE.config, ...(parsed.config || {}) },
      };
      saveStateToSqlite(global.__velnorMemoryState);
      return global.__velnorMemoryState;
    }
  } catch (err) {
    console.warn("Could not read store from disk, using in-memory default:", err);
  }
  global.__velnorMemoryState = structuredClone(DEFAULT_STATE);
  saveStore(global.__velnorMemoryState);
  return global.__velnorMemoryState;
}

export function saveStore(state: VelnorState): void {
  global.__velnorMemoryState = state;
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

export function getEffectiveKeys(state: VelnorState) {
  return {
    geminiApiKey: state.config.geminiApiKey || process.env.GEMINI_API_KEY || "",
    openaiApiKey: state.config.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: state.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
  };
}

