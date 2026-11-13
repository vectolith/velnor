import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { DEFAULT_MODELS } from "./ai/registry";
import { listStateKeysFromSqlite, loadStateFromSqlite, resolveWritableDataDir, saveStateToSqlite } from "./sqliteDb";
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

let resolvedUsersDir: string | null = null;
function getUsersDir(): string {
  if (!resolvedUsersDir) {
    const dataDir =
      (process.env.VELNOR_DATA_DIR && process.env.VELNOR_DATA_DIR.trim()) ||
      resolveWritableDataDir();
    resolvedUsersDir = path.join(dataDir, "users");
  }
  return resolvedUsersDir;
}
const ROOT_USER = "default";

/** Where Slack replies and reminders land when a profile has not overridden it. */
export const DEFAULT_SLACK_CHANNEL = "#velnor-agent";

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

/** Previous key format, retained only to migrate existing tenant data. */
function legacySanitizeUserId(raw: string): string {
  const cleaned = (raw || "").trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "_");
  return cleaned.slice(0, 96) || ROOT_USER;
}

/** Collision-resistant, filesystem-safe and idempotent tenant key. */
export function sanitizeUserId(raw: string): string {
  const value = (raw || "").trim();
  if (!value || value === ROOT_USER) return ROOT_USER;
  if (/^v2h_[a-f0-9]{64}$/.test(value)) return value;
  if (/^v2_(?:[A-Za-z0-9.@+-]|_x[0-9a-f]{2}_)*$/.test(value)) return value;
  const encoded = value.replace(/[^A-Za-z0-9.@+-]/g, (character) =>
    "_x" + character.charCodeAt(0).toString(16).padStart(2, "0") + "_"
  );
  const key = "v2_" + encoded;
  return key.length <= 96
    ? key
    : "v2h_" + crypto.createHash("sha256").update(value).digest("hex");
}

export function resolveUserId(channel: ChannelType | string, handle?: string): string {
  return String(channel) + ":" + (handle || "anonymous");
}

function stateFile(userId: string): string {
  return path.join(getUsersDir(), userId + ".json");
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
  const legacyId = legacySanitizeUserId(userId);
  const hit = cache().get(id);
  if (hit) return hit;

  const sqliteCurrent = loadStateFromSqlite(sqliteKey(id));
  const sqliteLegacy = legacyId !== id ? loadStateFromSqlite(sqliteKey(legacyId)) : null;
  const sqliteCandidate = sqliteCurrent
    ? { state: sqliteCurrent, legacy: false }
    : sqliteLegacy
      ? { state: sqliteLegacy, legacy: true }
      : null;

  let jsonCandidate: { state: VelnorState; legacy: boolean } | null = null;
  const jsonPaths = [
    { file: stateFile(id), legacy: false },
    ...(legacyId !== id ? [{ file: stateFile(legacyId), legacy: true }] : []),
  ];
  for (const candidate of jsonPaths) {
    if (!fs.existsSync(candidate.file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate.file, "utf-8")) as VelnorState;
      jsonCandidate = { state: parsed, legacy: candidate.legacy };
      break;
    } catch (err) {
      console.warn("Could not read store for " + id + " from " + candidate.file + ":", err);
      try {
        const quarantine = candidate.file + ".corrupt-" + Date.now();
        fs.renameSync(candidate.file, quarantine);
        console.warn("Quarantined unreadable state at " + quarantine);
      } catch (renameErr) {
        console.warn("Could not quarantine corrupt state:", renameErr);
      }
    }
  }

  const persistedAt = (state: VelnorState | null) => {
    const value = (state as (VelnorState & { persistedAt?: string }) | null)?.persistedAt;
    const parsed = value ? Date.parse(value) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const useJson = Boolean(
    jsonCandidate &&
    (!sqliteCandidate || persistedAt(jsonCandidate.state) > persistedAt(sqliteCandidate.state))
  );
  const selected = useJson ? jsonCandidate : sqliteCandidate;
  let loaded: VelnorState | null = selected?.state || null;
  const loadedFromLegacy = Boolean(selected?.legacy);

  // SQLite and the JSON mirror can fail independently. Choose the newest
  // durable copy, then apply identical migration, validation and decryption.
  let needsCredentialReseal = false;
  if (loaded) {
    const migrated = migrateState(loaded).value;
    const coerced = coerceState(migrated);
    if (coerced.issues.length > 0) {
      console.warn(`State for ${id} was repaired on load: ${coerced.issues.join("; ")}`);
    }
    const config = coerced.value.config;
    if (config && typeof config === "object") {
      const rawConfig = config as Record<string, unknown>;
      // Older SQLite rows may contain plaintext credentials. Detect them before
      // decryption, then rewrite the profile through saveStateForUser so AES-GCM
      // sealing is applied to both SQLite and the JSON recovery mirror.
      needsCredentialReseal = secretsEnabled() && Object.entries(rawConfig).some(
        ([key, value]) =>
          typeof value === "string" &&
          value.length > 0 &&
          isCredentialField(key) &&
          !isSealed(value)
      );
      coerced.value.config = openRecord(rawConfig);
    }
    loaded = coerced.value as unknown as VelnorState;
  }

  const state = mergeState(loaded);
  cache().set(id, state);
  if (!loaded || loadedFromLegacy || useJson || needsCredentialReseal) {
    saveStateForUser(id, state);
  }
  return state;
}

function saveStateForUser(userId: string, state: VelnorState): void {
  const id = sanitizeUserId(userId);
  const persisted = { ...state, schemaVersion: STATE_SCHEMA_VERSION, persistedAt: new Date().toISOString() };
  if (persisted.config && typeof persisted.config === "object") {
    persisted.config = sealRecord(persisted.config as unknown as Record<string, unknown>) as unknown as typeof persisted.config;
  }
  const sqliteSaved = saveStateToSqlite(persisted, sqliteKey(id));
  let jsonSaved = false;
  try {
    const usersDir = getUsersDir();
    if (!fs.existsSync(usersDir)) fs.mkdirSync(usersDir, { recursive: true });
    fs.writeFileSync(stateFile(id), JSON.stringify(persisted, null, 2), "utf-8");
    jsonSaved = true;
  } catch (err) {
    console.warn("Could not persist JSON recovery mirror for " + id + ":", err);
  }
  if (!sqliteSaved && !jsonSaved) {
    throw new Error("Velnor could not durably persist tenant state; refusing to report success.");
  }
  cache().set(id, state);
}

/** Run fn with the store bound to this user. */
export function withVelnorUser<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
  const id = sanitizeUserId(userId);
  const existing = storage.getStore();
  if (existing && existing.userId === id) return Promise.resolve(fn());
  return storage.run({ userId: id, state: loadUserState(userId) }, async () => fn());
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

/**
 * The Slack channel to post into. A configured value wins, so the deployment can
 * point at whichever channel actually exists without a code change.
 */
export function resolveSlackChannel(state: VelnorState): string {
  const configured = (state.config?.slackChannel || "").trim();
  if (configured) return configured;
  // Lets a deployment pin the channel (a stable channel id survives a rename)
  // without writing state, which matters when the volume is replaced on deploy.
  const fromEnv = (process.env.SLACK_CHANNEL || "").trim();
  return fromEnv || DEFAULT_SLACK_CHANNEL;
}

/**
 * Slack accepts either a channel name (#general) or an id (C0123456789). Anything
 * else would be rejected by the API later, so refuse it at the edge.
 */
export function isValidSlackChannel(value: string): boolean {
  const trimmed = value.trim();
  return /^#[a-z0-9][a-z0-9._-]{0,79}$/i.test(trimmed) || /^[CG][A-Z0-9]{6,}$/.test(trimmed);
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
  const ids = new Set<string>([...cache().keys(), ...listStateKeysFromSqlite()]);
  try {
    if (fs.existsSync(getUsersDir())) {
      for (const file of fs.readdirSync(getUsersDir())) {
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
