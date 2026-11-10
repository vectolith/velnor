import { currentUserId } from "@/lib/store";

/**
 * Privilege classification for tools, plus a confirmation gate for the ones that
 * leave the machine.
 *
 * Reading mail or searching the web is reversible. Sending mail as the owner and
 * writing to their calendar are not, so those tools refuse to run unless the
 * current user message is an explicit affirmative answering a proposal Velnor
 * made in the same conversation. The gate lives in code, not in the prompt.
 */

export const SENSITIVE_TOOLS = new Set(["draft_or_send_email", "create_calendar_event", "organize_email"]);

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 200;

interface PendingAction {
  tool: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAction>();
let lastUserMessage = "";

export function noteUserMessage(text: string): void {
  lastUserMessage = text || "";
}

export function isAffirmation(text: string): boolean {
  const normalised = (text || "").trim().toLowerCase();
  if (!normalised || normalised.length > 60) return false;
  return /^(yes|yep|yeah|y|ok|okay|confirm(ed)?|approve[d]?|do it|go ahead|send it|send|proceed|please do)\b/.test(
    normalised
  );
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

export function enforceToolPolicy(toolName: string): PolicyDecision {
  if (!SENSITIVE_TOOLS.has(toolName)) return { allowed: true };

  let userId = "default";
  try {
    userId = currentUserId();
  } catch {
    // Called outside a request scope (tests, CLI): fall back to the shared bucket.
  }

  const key = `${userId}:${toolName}`;
  const now = Date.now();
  const entry = pending.get(key);

  if (entry && entry.expiresAt > now && isAffirmation(lastUserMessage)) {
    pending.delete(key);
    return { allowed: true };
  }

  if (pending.size > MAX_PENDING) {
    for (const [pendingKey, action] of pending) {
      if (action.expiresAt <= now) pending.delete(pendingKey);
    }
  }
  pending.set(key, { tool: toolName, expiresAt: now + PENDING_TTL_MS });

  return {
    allowed: false,
    reason:
      `"${toolName}" changes something outside this assistant (it sends mail or writes to the calendar), ` +
      `so it needs your explicit yes. Nothing was executed. Confirm and it will run once.`,
  };
}

/** Test helper: clear the gate between cases. */
export function resetToolPolicy(): void {
  pending.clear();
  lastUserMessage = "";
}

export function pendingCount(): number {
  return pending.size;
}
