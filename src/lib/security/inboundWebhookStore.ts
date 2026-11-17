import { getSqliteDb } from "../sqliteDb";

/**
 * Durable inbound webhook dedupe.
 *
 * The in-memory cache is still the fast path, but it forgets on restart and is
 * per-instance, so a provider retry could run the agent (and bill the model)
 * twice. This ledger is the authority when SQLite is available and degrades to
 * "process it" rather than dropping a real message when it is not.
 */
export type InboundClaim = "new" | "duplicate" | "unavailable";

export function claimInboundWebhookEvent(input: {
  provider: string;
  eventKey: string;
  retentionDays?: number;
}): InboundClaim {
  const provider = String(input.provider || "").trim();
  const eventKey = String(input.eventKey || "").trim();
  if (!provider || !eventKey) return "unavailable";
  const database = getSqliteDb();
  if (!database) return "unavailable";

  const now = new Date().toISOString();
  try {
    const result = database.prepare(`
      INSERT INTO inbound_webhook_events (provider, event_key, received_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider, event_key) DO NOTHING
    `).run(provider, eventKey.slice(0, 200), now) as { changes?: number };
    if (Number(result.changes) === 1) {
      const retention = Math.max(1, Math.trunc(input.retentionDays ?? 7));
      const cutoff = new Date(Date.now() - retention * 24 * 60 * 60_000).toISOString();
      database.prepare("DELETE FROM inbound_webhook_events WHERE received_at < ?").run(cutoff);
      return "new";
    }
    return "duplicate";
  } catch (error) {
    console.error("Inbound webhook dedupe ledger failed:", error);
    return "unavailable";
  }
}

/** Release a claim when processing failed, so the provider retry can be handled. */
export function releaseInboundWebhookEvent(provider: string, eventKey: string): void {
  const database = getSqliteDb();
  if (!database || !provider || !eventKey) return;
  try {
    database.prepare("DELETE FROM inbound_webhook_events WHERE provider = ? AND event_key = ?")
      .run(provider, eventKey.slice(0, 200));
  } catch (error) {
    console.error("Inbound webhook claim could not be released:", error);
  }
}
