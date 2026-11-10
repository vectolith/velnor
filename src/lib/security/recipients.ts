/**
 * Outbound recipient policy for email.
 *
 * Velnor can send mail as the owner. When the owner supplies an allowlist
 * (VELNOR_EMAIL_ALLOWLIST, comma separated, entries are either full addresses or
 * "@domain"), anything else is refused before the send call is made. With no
 * allowlist configured nothing changes, so this is opt-in and never silently
 * narrows an existing deployment.
 */

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isRecipientAllowed(address: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalised = (address || "").trim().toLowerCase();
  if (!normalised.includes("@")) return false;
  const domain = normalised.slice(normalised.indexOf("@"));
  return allowlist.some((entry) => entry === normalised || entry === domain || normalised.endsWith(entry.startsWith("@") ? entry : `@${entry}`));
}

export class RecipientNotAllowedError extends Error {
  constructor(address: string) {
    super(`Recipient ${address} is not in VELNOR_EMAIL_ALLOWLIST`);
    this.name = "RecipientNotAllowedError";
  }
}

export function assertRecipientAllowed(address: string, allowlist: string[]): void {
  if (!isRecipientAllowed(address, allowlist)) {
    throw new RecipientNotAllowedError(address);
  }
}
