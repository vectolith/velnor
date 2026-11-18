const EMAIL_IDENTITY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeImessageIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identity = value.trim();
  if (!identity || identity.length > 254) return null;
  if (identity.includes("@")) return EMAIL_IDENTITY.test(identity) ? identity.toLowerCase() : null;
  return identity.slice(0, 64);
}

export function isLoopMessagePayload(payload: Record<string, unknown>): boolean {
  return Boolean(payload.contact || payload.email || payload.from_email || payload.apple_id) ||
    payload.event === "message_inbound";
}

export function getLoopMessageRecipient(payload: Record<string, unknown>): string | null {
  return normalizeImessageIdentity(payload.contact || payload.email || payload.from_email || payload.apple_id);
}
