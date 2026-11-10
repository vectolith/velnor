/**
 * Bounded TTL set used to drop duplicate inbound webhooks.
 *
 * Providers retry: Twilio re-posts when a response is slow, Slack retries after
 * three seconds. Without a dedupe key a retry mints a second reminder, sends a
 * second email or charges a second LLM call.
 */
export class BoundedTtlCache {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 10 * 60 * 1000, maxEntries = 2000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /** Returns true the first time a key is seen; false for repeats inside the TTL. */
  seen(key: string, now: number = Date.now()): boolean {
    this.prune(now);
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) return false;
    this.entries.set(key, now + this.ttlMs);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  private prune(now: number): void {
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const inboundWebhookCache = new BoundedTtlCache();

/** Build a stable dedupe key from whatever identity the provider supplies. */
export function inboundKey(parts: Array<string | null | undefined>): string {
  const usable = parts.filter((part): part is string => Boolean(part && part.trim()));
  return usable.length > 0 ? usable.join("|") : "";
}
