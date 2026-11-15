import type { PersistedTenantState } from "../storage/d1TenantState";
import type { TenantRepository } from "../storage/tenantRepository";

export const SENSITIVE_TOOLS = new Set([
  "draft_or_send_email",
  "create_calendar_event",
  "organize_email",
  "delegate_browser_task",
]);

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 200;

interface PendingAction {
  fingerprint: string;
  expiresAt: number;
  messageSequenceAtCreation: number;
}

interface UserAffirmation {
  affirmative: boolean;
  messageSequence: number;
}

interface PersistedToolPolicyState {
  messageSequence: number;
  lastUserAffirmation?: UserAffirmation;
  pending: Record<string, PendingAction>;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

function initialState(): PersistedTenantState {
  return {
    toolPolicyState: { messageSequence: 0, pending: {} },
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

function ensurePolicyState(draft: PersistedTenantState): PersistedToolPolicyState {
  const raw = draft.toolPolicyState;
  const state = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Partial<PersistedToolPolicyState>
    : {};
  const pending = state.pending && typeof state.pending === "object" && !Array.isArray(state.pending)
    ? state.pending
    : {};
  const policy: PersistedToolPolicyState = {
    messageSequence: Number.isSafeInteger(state.messageSequence) && Number(state.messageSequence) >= 0
      ? Number(state.messageSequence)
      : 0,
    lastUserAffirmation: state.lastUserAffirmation,
    pending: pending as Record<string, PendingAction>,
  };
  draft.toolPolicyState = policy;
  return policy;
}

function isAffirmation(text: string): boolean {
  const normalised = (text || "").trim().toLowerCase();
  if (!normalised || normalised.length > 60) return false;
  return /^(yes|yep|yeah|y|ok|okay|confirm(ed)?|approve[d]?|do it|go ahead|send it|send|proceed|please do)[.! ]*$/.test(normalised);
}

async function fingerprint(args: Record<string, unknown>): Promise<string> {
  const serialized = JSON.stringify(args);
  if (typeof serialized !== "string") throw new Error("Tool arguments must be JSON-serializable.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pruneExpired(pending: Record<string, PendingAction>, now: number): void {
  for (const [key, action] of Object.entries(pending)) {
    if (!action || !Number.isFinite(action.expiresAt) || action.expiresAt <= now) delete pending[key];
  }
}

/** Persist the latest user message/affirmation in the authenticated tenant's state. */
export async function noteUserMessageAsync(
  repository: TenantRepository,
  tenantId: string,
  text: string,
): Promise<void> {
  await repository.update(tenantId, initialState, (draft) => {
    const state = ensurePolicyState(draft);
    state.messageSequence += 1;
    state.lastUserAffirmation = {
      affirmative: isAffirmation(text),
      messageSequence: state.messageSequence,
    };
    pruneExpired(state.pending, Date.now());
  });
}

/**
 * Atomically check and consume a tenant-bound confirmation. The repository
 * mutation contains no network calls or other external side effects.
 */
export async function enforceToolPolicyAsync(
  repository: TenantRepository,
  tenantId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<PolicyDecision> {
  if (!SENSITIVE_TOOLS.has(toolName)) return { allowed: true };

  const expectedFingerprint = await fingerprint(args);
  const now = Date.now();
  let decision: PolicyDecision = {
    allowed: false,
    reason:
      `"${toolName}" affects an external account or performs a delegated action. ` +
      "Nothing was executed. Explicit confirmation is required for this exact operation in your next message.",
  };

  await repository.update(tenantId, initialState, (draft) => {
    const state = ensurePolicyState(draft);
    pruneExpired(state.pending, now);
    const entry = state.pending[toolName];
    const affirmation = state.lastUserAffirmation;

    if (
      entry &&
      entry.expiresAt > now &&
      entry.fingerprint === expectedFingerprint &&
      affirmation?.affirmative === true &&
      affirmation.messageSequence > entry.messageSequenceAtCreation
    ) {
      delete state.pending[toolName];
      delete state.lastUserAffirmation;
      decision = { allowed: true };
      return;
    }

    if (!entry && Object.keys(state.pending).length >= MAX_PENDING) {
      decision = { allowed: false, reason: "Too many pending confirmations. Try again later." };
      return;
    }

    state.pending[toolName] = {
      fingerprint: expectedFingerprint,
      expiresAt: now + PENDING_TTL_MS,
      messageSequenceAtCreation: state.messageSequence,
    };
  });

  return decision;
}
