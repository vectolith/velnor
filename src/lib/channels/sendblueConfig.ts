/**
 * Sendblue configuration resolution and validation.
 *
 * Tenant config wins over environment variables so a workspace can run its own
 * line, while a single-tenant deployment can be configured entirely from env.
 * Everything is validated once here instead of being trusted at the send site,
 * so a malformed number fails loudly at startup/health rather than silently
 * producing unsendable messages.
 */

export interface SendblueConfig {
  apiKeyId: string;
  apiSecret: string;
  fromNumber: string;
  webhookSecret: string;
  publicUrl: string;
}

export interface SendblueConfigReport {
  config: SendblueConfig;
  issues: string[];
  configured: boolean;
}

/** Normalize a human-entered number (spaces, dashes, parens, 00 prefix). */
export function normalizeE164(value: unknown, defaultCountryCode = "1"): string | null {
  if (typeof value !== "string") return null;
  let digits = value.trim().replace(/[^0-9+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (!digits.startsWith("+")) {
    const bare = digits.replace(/[^0-9]/g, "");
    if (bare.length === 10) digits = "+" + defaultCountryCode + bare;
    else if (bare.length === 11 && bare.startsWith(defaultCountryCode)) digits = "+" + bare;
    else digits = "+" + bare;
  }
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function readString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function resolveSendblueConfig(
  tenantConfig?: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv = process.env,
): SendblueConfigReport {
  const source = (tenantConfig ?? {}) as Record<string, unknown>;
  const apiKeyId = readString(source, ["sendblueApiKey", "sendblueApiKeyId"]) || String(env.SENDBLUE_API_KEY || "").trim();
  const apiSecret = readString(source, ["sendblueApiSecret"]) || String(env.SENDBLUE_API_SECRET || "").trim();
  const rawFrom = readString(source, ["sendblueFromNumber", "sendblueNumber"]) || String(env.SENDBLUE_FROM_NUMBER || "").trim();
  const webhookSecret = readString(source, ["sendblueWebhookSecret"]) || String(env.SENDBLUE_WEBHOOK_SECRET || "").trim();
  const publicUrl = String(env.VELNOR_PUBLIC_URL || "").trim().replace(/\/+$/, "");

  const issues: string[] = [];
  const fromNumber = normalizeE164(rawFrom);
  if (!apiKeyId) issues.push("SENDBLUE_API_KEY is missing.");
  if (!apiSecret) issues.push("SENDBLUE_API_SECRET is missing.");
  if (!rawFrom) issues.push("SENDBLUE_FROM_NUMBER is missing.");
  else if (!fromNumber) issues.push("SENDBLUE_FROM_NUMBER must be a valid E.164 number.");
  if (webhookSecret && webhookSecret.length < 16) issues.push("SENDBLUE_WEBHOOK_SECRET should be at least 16 characters.");

  return {
    config: { apiKeyId, apiSecret, fromNumber: fromNumber ?? "", webhookSecret, publicUrl },
    issues,
    configured: Boolean(apiKeyId && apiSecret && fromNumber),
  };
}
