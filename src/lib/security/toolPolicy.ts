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
}

const pending = new Map<string, PendingAction>();
const lastUserMessages = new Map<string, string>();

function scopedKey(toolName: string): string {
  return currentUserId() + ":" + toolName;
}

export function noteUserMessage(text: string): void {
  lastUserMessages.set(currentUserId(), text || "");
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
    isAffirmation(lastUserMessages.get(userId) || "")
  ) {
    pending.delete(key);
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

  pending.set(key, { fingerprint, expiresAt: now + PENDING_TTL_MS });
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
  lastUserMessages.clear();
}

export function pendingCount(): number {
  return pending.size;
}
