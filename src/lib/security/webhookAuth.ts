import crypto from "crypto";

/**
 * Webhook authentication, fail-closed.
 *
 * Every rule here is the same shape: if a provider secret is configured the
 * request must prove it knows that secret, and in production a missing secret is
 * a configuration error (503), never a silent pass. The simulator escape hatch is
 * developer-only: it requires NODE_ENV !== "production" *and* an explicit
 * VELNOR_ALLOW_SIMULATOR=1, so a stray header cannot unlock a live deployment.
 */

export const SLACK_MAX_SKEW_SECONDS = 300;

/**
 * Read the environment through a variable rather than the literal property, so
 * bundlers cannot inline process.env.NODE_ENV and freeze the check at build time.
 */
const runtimeEnv = process.env;

function isProduction(): boolean {
  return String(runtimeEnv.NODE_ENV || "") === "production";
}

export interface WebhookDecision {
  ok: boolean;
  status?: number;
  error?: string;
}

function deny(status: number, error: string): WebhookDecision {
  return { ok: false, status, error };
}

/** Length-guarded comparison that still burns constant time on mismatch. */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Separate deployment perimeter credential; never substitute an admin token. */
export function authorizeGatewayRequest(
  secret: string | undefined,
  provided: string | null | undefined
): WebhookDecision {
  if (!secret || secret.length < 32) {
    return deny(503, "Gateway perimeter authentication is not configured.");
  }
  if (!provided || !timingSafeEquals(provided, secret)) {
    return deny(401, "Request must pass through the trusted API gateway.");
  }
  return { ok: true };
}

export function authorizeCronRequest(secret: string | undefined, provided: string | null | undefined): WebhookDecision {
  if (!secret || secret.length < 32) {
    return deny(503, "Cron authentication is not configured.");
  }
  if (!provided || !timingSafeEquals(provided, secret)) {
    return deny(401, "Unauthorized cron invocation.");
  }
  return { ok: true };
}

export function isSimulatorAllowed(headerValue: string | null | undefined): boolean {
  return (
    !isProduction() &&
    runtimeEnv.VELNOR_ALLOW_SIMULATOR === "1" &&
    headerValue === "true"
  );
}

/**
 * Twilio: HMAC-SHA1 over the full URL with parameters appended in key-sorted
 * order, base64 encoded (https://www.twilio.com/docs/usage/security).
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(Buffer.from(payload, "utf8")).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  signature: string | null | undefined,
  url: string,
  params: Record<string, string>
): boolean {
  if (!authToken || !signature) return false;
  return timingSafeEquals(computeTwilioSignature(authToken, url, params), signature);
}

/**
 * Slack: v0 signature over "v0:{timestamp}:{rawBody}". The timestamp must be
 * within the skew window or a captured request replays forever.
 */
export function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string
): string {
  const digest = crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${digest}`;
}

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null | undefined,
  signature: string | null | undefined,
  signingSecret: string,
  nowMs: number = Date.now(),
  maxSkewSeconds: number = SLACK_MAX_SKEW_SECONDS
): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - parsed) > maxSkewSeconds) return false;
  return timingSafeEquals(computeSlackSignature(signingSecret, timestamp, rawBody), signature);
}

export function authorizeTwilioRequest(input: {
  authToken: string | undefined;
  signature: string | null | undefined;
  url: string;
  params: Record<string, string>;
  simulator: boolean;
}): WebhookDecision {
  if (input.simulator) return { ok: true };
  if (!input.authToken) {
    return deny(503, "Twilio is not configured: set TWILIO_AUTH_TOKEN.");
  }
  if (!input.signature) {
    return deny(401, "Missing X-Twilio-Signature.");
  }
  if (!verifyTwilioSignature(input.authToken, input.signature, input.url, input.params)) {
    return deny(401, "Invalid X-Twilio-Signature.");
  }
  return { ok: true };
}

export function authorizeSlackRequest(input: {
  signingSecret: string | undefined;
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  simulator: boolean;
  nowMs?: number;
}): WebhookDecision {
  if (input.simulator) return { ok: true };
  if (!input.signingSecret) {
    return deny(503, "Slack is not configured: set SLACK_SIGNING_SECRET.");
  }
  const valid = verifySlackSignature(
    input.rawBody,
    input.timestamp,
    input.signature,
    input.signingSecret,
    input.nowMs
  );
  return valid ? { ok: true } : deny(401, "Invalid or stale Slack signature.");
}

/**
 * Sendblue and LoopMessage post JSON and have no signing scheme of their own, so
 * they authenticate with a shared secret header that the provider is configured
 * to send. Any configured secret is accepted.
 */
export function authorizeJsonWebhook(input: {
  secrets: Array<string | undefined>;
  provided: string | null | undefined;
  simulator: boolean;
}): WebhookDecision {
  if (input.simulator) return { ok: true };
  const configured = input.secrets.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (configured.length === 0) {
    if (isProduction()) {
      return deny(
        503,
        "JSON webhook auth is not configured: set SENDBLUE_WEBHOOK_SECRET or LOOPMESSAGE_WEBHOOK_SECRET."
      );
    }
    // Outside production an unconfigured secret stays usable for local testing.
    return { ok: true };
  }
  if (!input.provided) {
    return deny(401, "Missing x-velnor-webhook-secret header.");
  }
  return configured.some((secret) => timingSafeEquals(secret, input.provided as string))
    ? { ok: true }
    : deny(401, "Invalid webhook secret.");
}

/**
 * Build the URL Twilio signs from a configured canonical origin. Forwarded and
 * Host headers are attacker-controlled unless every hop is explicitly trusted;
 * never use them to select the signature input in production.
 */
export function publicRequestUrl(req: {
  nextUrl: { origin?: string; pathname: string; search: string };
}): string {
  const configuredOrigin = runtimeEnv.VELNOR_PUBLIC_URL;
  if (isProduction() && !configuredOrigin) {
    throw new Error("VELNOR_PUBLIC_URL must be configured for production webhook signature verification.");
  }
  const base = configuredOrigin || req.nextUrl.origin || "";
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    throw new Error("VELNOR_PUBLIC_URL must be a valid absolute URL.");
  }
  if (
    origin.username || origin.password || origin.pathname !== "/" ||
    origin.search || origin.hash || (isProduction() && origin.protocol !== "https:")
  ) {
    throw new Error("VELNOR_PUBLIC_URL must be a canonical HTTPS origin in production.");
  }
  return new URL(req.nextUrl.pathname + req.nextUrl.search, origin).toString();
}
