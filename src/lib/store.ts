import { AsyncLocalStorage } from "node:async_hooks";
import fs from "fs";
import path from "path";
import { DEFAULT_MODELS } from "./ai/registry";
import { loadStateFromSqlite, resolveWritableDataDir, saveStateToSqlite } from "./sqliteDb";
import { coerceState, migrateState, STATE_SCHEMA_VERSION } from "./security/stateSchema";
import { isCredentialField, isSealed, openRecord, sealRecord, secretsEnabled } from "./security/secretBox";
import {
  CalendarEventItem,
  ChannelType,
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
  conversationCursors: Record<string, string>; // channelKey -> last interactionId
  /** Rolling token/cost accounting, surfaced on /api/health. */
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    lastRequestCostUsd?: number;
    lastProvider?: string;
    lastModel?: string;
  };
}

const DATA_DIR =
  (process.env.VELNOR_DATA_DIR && process.env.VELNOR_DATA_DIR.trim()) ||
  resolveWritableDataDir();
const USERS_DIR = path.join(DATA_DIR, "users");
const ROOT_USER = "default";

export const DEFAULT_STATE: VelnorState = {
  messages: [],
  reminders: [],
  calendarEvents: [],
  emails: [],
  documents: [],
  documentChunks: [],
  memories: [],
  config: {
    activeProvider: "auto",
    geminiModel: DEFAULT_MODELS.gemini,
    geminiImageModel: process.env.VELNOR_IMAGE_MODEL || "gemini-2.5-flash-image",
    openaiModel: DEFAULT_MODELS.openai,
    anthropicModel: DEFAULT_MODELS.anthropic,
  },
  conversationCursors: {},
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
};

declare global {
  // eslint-disable-next-line no-var
  var __velnorStates: Map<string, VelnorState> | undefined;
}

/**
 * Per-request tenant scope. Every existing call site keeps using getStore() /
 * saveStore(); they simply resolve to the user the request is bound to.
 */
interface StoreScope {
  userId: string;
  state: VelnorState;
}
const storage = new AsyncLocalStorage<StoreScope>();

/** Stable, filesystem-safe tenant key. */
export function sanitizeUserId(raw: string): string {
  const cleaned = (raw || "").trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_");
  return cleaned.slice(0, 96) || ROOT_USER;
}

export function resolveUserId(channel: ChannelType | string, handle?: string): string {
  if (!handle) return sanitizeUserId("anon:" + channel);
  return sanitizeUserId(String(channel) + ":" + handle);
}

function stateFile(userId: string): string {
  return path.join(USERS_DIR, userId + ".json");
}

function sqliteKey(userId: string): string {
  // The legacy key stays for the default tenant so existing data is adopted.
  return userId === ROOT_USER ? "velnor_root_state" : "state:" + userId;
}

function cache(): Map<string, VelnorState> {
  if (!global.__velnorStates) global.__velnorStates = new Map();
  return global.__velnorStates;
}

/** Model names that were never real; replace them on load. */
const LEGACY_MODELS: Record<string, string> = {
  "gemini-3.8-flash": DEFAULT_MODELS.gemini,
  "gemini-3.1-flash-image": DEFAULT_STATE.config.geminiImageModel,
  "claude-3-7-sonnet-latest": DEFAULT_MODELS.anthropic,
};

function migrateConfig(config: Partial<ProviderConfig> | undefined): ProviderConfig {
  const merged = { ...DEFAULT_STATE.config, ...(config || {}) };
  for (const key of ["geminiModel", "geminiImageModel", "openaiModel", "anthropicModel"] as const) {
    const value = merged[key];
    if (value && LEGACY_MODELS[value]) merged[key] = LEGACY_MODELS[value];
  }
  return merged;
}

function mergeState(loaded: Partial<VelnorState> | null | undefined): VelnorState {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...(loaded || {}),
    config: migrateConfig(loaded?.config),
    usage: {
      requests: loaded?.usage?.requests ?? 0,
      inputTokens: loaded?.usage?.inputTokens ?? 0,
      outputTokens: loaded?.usage?.outputTokens ?? 0,
      costUsd: loaded?.usage?.costUsd ?? 0,
      lastRequestCostUsd: loaded?.usage?.lastRequestCostUsd,
      lastProvider: loaded?.usage?.lastProvider,
      lastModel: loaded?.usage?.lastModel,
    },
  };
}

/** Load (and cache) the state for one tenant. */
export function loadUserState(userId: string): VelnorState {
  const id = sanitizeUserId(userId);
  const hit = cache().get(id);
  if (hit) return hit;

  let loaded: VelnorState | null = loadStateFromSqlite(sqliteKey(id));
  if (!loaded) {
    try {
      const file = stateFile(id);
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        const migrated = migrateState(parsed).value;
        const coerced = coerceState(migrated);
        if (coerced.issues.length > 0) {
          console.warn(`State for ${id} was repaired on load: ${coerced.issues.join("; ")}`);
        }
        const config = coerced.value.config;
        if (config && typeof config === "object") {
          coerced.value.config = openRecord(config as Record<string, unknown>);
        }
        loaded = coerced.value as unknown as VelnorState;
      }
    } catch (err) {
      // Recovery: keep the broken file for inspection instead of silently
      // overwriting it, then start from a clean state.
      console.warn("Could not read store for " + id + ", starting fresh:", err);
      try {
        const file = stateFile(id);
        if (fs.existsSync(file)) {
          const quarantine = `${file}.corrupt-${Date.now()}`;
          fs.renameSync(file, quarantine);
          console.warn(`Quarantined unreadable state at ${quarantine}`);
        }
      } catch (renameErr) {
        console.warn("Could not quarantine corrupt state:", renameErr);
      }
    }
  }

  const state = mergeState(loaded);
  cache().set(id, state);
  if (!loaded) saveStateForUser(id, state);
  return state;
}

function saveStateForUser(userId: string, state: VelnorState): void {
  const id = sanitizeUserId(userId);
  const persisted = { ...state, schemaVersion: STATE_SCHEMA_VERSION };
  if (persisted.config && typeof persisted.config === "object") {
    persisted.config = sealRecord(persisted.config as unknown as Record<string, unknown>) as unknown as typeof persisted.config;
  }
  cache().set(id, state);
  saveStateToSqlite(persisted, sqliteKey(id));
  try {
    if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
    fs.writeFileSync(stateFile(id), JSON.stringify(persisted, null, 2), "utf-8");
  } catch (err) {
    console.warn("Non-fatal: could not persist store for " + id + ":", err);
  }
}

/** Run fn with the store bound to this user. */
export function withVelnorUser<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
  const id = sanitizeUserId(userId);
  const existing = storage.getStore();
  if (existing && existing.userId === id) return Promise.resolve(fn());
  return storage.run({ userId: id, state: loadUserState(id) }, async () => fn());
}

export function currentUserId(): string {
  return storage.getStore()?.userId || ROOT_USER;
}

export function getStore(): VelnorState {
  const scope = storage.getStore();
  if (scope) return scope.state;
  return loadUserState(ROOT_USER);
}

export function saveStore(state: VelnorState): void {
  const scope = storage.getStore();
  saveStateForUser(scope ? scope.userId : ROOT_USER, state);
}

export function getEffectiveKeys(state: VelnorState) {
  return {
    geminiApiKey: state.config.geminiApiKey || process.env.GEMINI_API_KEY || "",
    openaiApiKey: state.config.openaiApiKey || process.env.OPENAI_API_KEY || "",
    anthropicApiKey: state.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "",
  };
}

/** Every tenant that has state on disk or in cache. */
export function listUserIds(): string[] {
  const ids = new Set<string>(cache().keys());
  try {
    if (fs.existsSync(USERS_DIR)) {
      for (const file of fs.readdirSync(USERS_DIR)) {
        if (file.endsWith(".json")) ids.add(file.slice(0, -5));
      }
    }
  } catch {
    // ignore
  }
  return Array.from(ids);
}

/** Sum token/cost usage across tenants for /api/health. */
export function aggregateUsage() {
  const total = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tenants: 0 };
  for (const id of listUserIds()) {
    const usage = loadUserState(id).usage;
    if (!usage) continue;
    total.requests += usage.requests || 0;
    total.inputTokens += usage.inputTokens || 0;
    total.outputTokens += usage.outputTokens || 0;
    total.costUsd += usage.costUsd || 0;
    total.tenants++;
  }
  total.costUsd = Number(total.costUsd.toFixed(6));
  return total;
}

/** Test hook: drop all cached tenant state. */
export function resetStoreCache(): void {
  cache().clear();
}
