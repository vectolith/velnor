import crypto from "node:crypto";
import { currentUserId } from "@/lib/store";

/** Operations that can affect external accounts or execute delegated actions. */
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

const pending = new Map<string, PendingAction>();
const lastUserAffirmations = new Map<string, UserAffirmation>();
const userMessageSequences = new Map<string, number>();

function scopedKey(toolName: string): string {
  return currentUserId() + ":" + toolName;
}

export function noteUserMessage(text: string): void {
  const userId = currentUserId();
  const messageSequence = (userMessageSequences.get(userId) || 0) + 1;
  userMessageSequences.set(userId, messageSequence);
  if (userMessageSequences.size > MAX_PENDING * 10) {
    const oldest = userMessageSequences.keys().next().value;
    if (oldest) {
      userMessageSequences.delete(oldest);
      lastUserAffirmations.delete(oldest);
    }
  }
  lastUserAffirmations.set(userId, {
    affirmative: isAffirmation(text),
    messageSequence,
  });
  if (lastUserAffirmations.size > MAX_PENDING * 10) {
    const oldest = lastUserAffirmations.keys().next().value;
    if (oldest) lastUserAffirmations.delete(oldest);
  }
}

export function isAffirmation(text: string): boolean {
  const normalised = (text || "").trim().toLowerCase();
  if (!normalised || normalised.length > 60) return false;
  return /^(yes|yep|yeah|y|ok|okay|confirm(ed)?|approve[d]?|do it|go ahead|send it|send|proceed|please do)[.! ]*$/.test(normalised);
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Confirmation is bound to the authenticated tenant, tool and exact argument
 * payload. A confirmation from another tenant or for different arguments cannot
 * authorize this operation.
 */
export function enforceToolPolicy(
  toolName: string,
  args: Record<string, unknown> = {}
): PolicyDecision {
  if (!SENSITIVE_TOOLS.has(toolName)) return { allowed: true };

  const userId = currentUserId();
  const key = scopedKey(toolName);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const now = Date.now();
  const entry = pending.get(key);

  if (
    entry &&
    entry.expiresAt > now &&
    entry.fingerprint === fingerprint &&
    lastUserAffirmations.get(userId)?.affirmative === true &&
    lastUserAffirmations.get(userId)!.messageSequence > entry.messageSequenceAtCreation
  ) {
    pending.delete(key);
    lastUserAffirmations.delete(userId);
    return { allowed: true };
  }

  if (pending.size >= MAX_PENDING) {
    for (const [pendingKey, action] of pending) {
      if (action.expiresAt <= now) pending.delete(pendingKey);
    }
    if (pending.size >= MAX_PENDING) {
      return { allowed: false, reason: "Too many pending confirmations. Try again later." };
    }
  }

  pending.set(key, {
    fingerprint,
    expiresAt: now + PENDING_TTL_MS,
    messageSequenceAtCreation: userMessageSequences.get(userId) || 0,
  });
  return {
    allowed: false,
    reason:
      `"${toolName}" affects an external account or performs a delegated action. ` +
      "Nothing was executed. Explicit confirmation is required for this exact operation in your next message.",
  };
}

/** Test helper: clear all confirmation state between cases. */
export function resetToolPolicy(): void {
  pending.clear();
  lastUserAffirmations.clear();
  userMessageSequences.clear();
}

export function pendingCount(): number {
  return pending.size;
}
