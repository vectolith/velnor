import { listUserIds, sanitizeUserId } from "@/lib/store";

/**
 * Tenant selection for the control plane.
 *
 * Webhook tenants are already bound to the signed provider payload. The HTTP API
 * is different: it takes a user from a request header, which is caller-chosen. It
 * may only select a profile that already exists (or the default one); inventing a
 * new tenant id from a header is refused, so a caller cannot create or address
 * arbitrary partitions.
 */

export interface TenantDecision {
  ok: boolean;
  userId: string;
  status?: number;
  error?: string;
}

export const DEFAULT_TENANT = "owner";

export function authorizeChatTenant(raw: string | null | undefined, knownUsers?: string[]): TenantDecision {
  const supplied = String(raw ?? "").trim();
  const defaultTenant = sanitizeUserId(DEFAULT_TENANT);
  if (!supplied) {
    return { ok: true, userId: defaultTenant };
  }

  const requested = sanitizeUserId(supplied);
  const known = (knownUsers ?? safeListUsers()).map((id) => sanitizeUserId(id));

  if (!requested || requested === defaultTenant) {
    return { ok: true, userId: defaultTenant };
  }
  if (known.includes(requested)) {
    return { ok: true, userId: requested };
  }
  return {
    ok: false,
    userId: defaultTenant,
    status: 403,
    error: `Unknown tenant: ${requested}. Only existing profiles can be addressed.`,
  };
}

function safeListUsers(): string[] {
  try {
    return listUserIds();
  } catch {
    return [];
  }
}
