import { NextRequest, NextResponse } from "next/server";
import { authorizeGatewayRequest } from "@/lib/security/gatewayAuth";

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 90;
const MAX_RATE_BUCKETS = 10_000;

// Constant-time-ish string compare (middleware runs on the edge runtime, where
// node:crypto is unavailable).
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Trust Cloudflare's client-IP header only when the deployment secret proves
// the request passed through the identity gateway. A direct-origin caller can
// forge CF-Connecting-IP; untrusted traffic therefore shares one bounded bucket.
function getRateLimitKey(req: NextRequest, sharedSecret: string): string {
  // Trust Cloudflare's edge-supplied address only after proving this request
  // passed through the gateway that overwrites x-velnor-secret. Direct-origin
  // callers can forge CF-Connecting-IP, so they share the anonymous bucket.
  const providedSecret = req.headers.get("x-velnor-secret") || "";
  const trustedGateway = sharedSecret.length >= 32 && safeEquals(providedSecret, sharedSecret);
  const cloudflareIp = trustedGateway ? req.headers.get("cf-connecting-ip")?.trim() : "";
  return cloudflareIp ? "cf:" + cloudflareIp : "anonymous";
}

function pruneRateBuckets(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
  while (rateBuckets.size >= MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value;
    if (!oldest) break;
    rateBuckets.delete(oldest);
  }
}

// Endpoints that spend API credits, read user state, or write configuration.
const PROTECTED: Array<{ path: string; methods: string[] }> = [
  { path: "/api/chat", methods: ["GET", "POST"] },
  { path: "/api/siri", methods: ["POST"] },
  { path: "/api/settings", methods: ["POST"] },
  { path: "/api/lora-pilot", methods: ["GET", "POST"] },
  { path: "/api/tts", methods: ["POST"] },
];

function isValidPilotUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "169.254.169.254" ||
      host === "metadata.google.internal" ||
      host === "metadata.internal"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Apply rate limiting to API routes.
  if (pathname.startsWith("/api/")) {
    // Shared-secret gate. Without it these routes are world-readable and
    // world-writable, which means anyone with the URL can read the user's
    // mail and spend their API credits.
    const sharedSecret =
      process.env.VELNOR_SHARED_SECRET || "";
    // Simulator bypass is strictly development-only. Keep this aligned with
    // webhookAuth.isSimulatorAllowed so a production env flag cannot bypass auth.
    const allowSimulator =
      process.env.NODE_ENV !== "production" &&
      process.env.VELNOR_ALLOW_SIMULATOR === "1" &&
      req.headers.get("x-velnor-simulator") === "true";
    const needsAuth = PROTECTED.some(
      (route) => route.path === pathname && route.methods.includes(req.method)
    );
    const requiresGatewaySecret =
      pathname === "/api/webhooks/imessage" ||
      pathname === "/api/webhooks/slack" ||
      pathname.startsWith("/api/cron/") ||
      pathname === "/api/auth/google/callback";

    if (requiresGatewaySecret && req.method !== "OPTIONS" && process.env.NODE_ENV === "production") {
      const decision = authorizeGatewayRequest(sharedSecret, req.headers.get("x-velnor-secret"));
      if (!decision.ok) {
        return NextResponse.json({ error: decision.error }, { status: decision.status ?? 401 });
      }
    }

    const pilotUrl = process.env.VELNOR_LORA_PILOT_URL;
    if (pilotUrl && !isValidPilotUrl(pilotUrl)) {
      return NextResponse.json(
        { error: "Configuration error: VELNOR_LORA_PILOT_URL is malformed or invalid." },
        { status: 500 }
      );
    }

    if (needsAuth && !allowSimulator && (sharedSecret || process.env.NODE_ENV === "production")) {
      // Authorization is reserved for the per-user identity JWT verified
      // by the route handler. Only the dedicated deployment secret establishes
      // the perimeter; admin tokens and legacy key headers are not substitutes.
      const decision = authorizeGatewayRequest(sharedSecret, req.headers.get("x-velnor-secret"));
      if (!decision.ok) {
        return NextResponse.json(
          { error: decision.error },
          { status: decision.status ?? 401 }
        );
      }
    }

    // Webhook signature and credential sanitation.
    if (!allowSimulator) {
      if (pathname === "/api/webhooks/imessage") {
        const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
        const isTwilioForm = req.headers.get("content-type")?.includes("application/x-www-form-urlencoded");
        if (twilioAuthToken && isTwilioForm) {
          const sig = req.headers.get("x-twilio-signature");
          if (!sig) {
            return NextResponse.json(
              { error: "Unauthorized: missing required X-Twilio-Signature." },
              { status: 401 }
            );
          }
        }

        const bluebubblesPassword = process.env.BLUEBUBBLES_PASSWORD;
        if (bluebubblesPassword && !isTwilioForm) {
          const providedPassword =
            req.headers.get("x-bluebubbles-password") ||
            req.nextUrl.searchParams.get("password") ||
            req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
            "";
          if (!safeEquals(providedPassword, bluebubblesPassword)) {
            return NextResponse.json(
              { error: "Unauthorized: valid BLUEBUBBLES_PASSWORD required." },
              { status: 401 }
            );
          }
        }
      }

      if (pathname === "/api/webhooks/slack") {
        const slackSecret = process.env.SLACK_SIGNING_SECRET;
        if (slackSecret) {
          const sig = req.headers.get("x-slack-signature");
          const ts = req.headers.get("x-slack-request-timestamp");
          if (!sig || !ts) {
            return NextResponse.json(
              { error: "Unauthorized: missing required Slack signature headers." },
              { status: 401 }
            );
          }
          const tsNum = parseInt(ts, 10);
          if (isNaN(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
            return NextResponse.json(
              { error: "Unauthorized: Slack request timestamp expired or invalid." },
              { status: 401 }
            );
          }
        }
      }
    }

    const now = Date.now();
    const key = getRateLimitKey(req, sharedSecret);
    let existing = rateBuckets.get(key);
    if (!existing || now > existing.resetAt) {
      if (rateBuckets.size >= MAX_RATE_BUCKETS) pruneRateBuckets(now);
      existing = { count: 0, resetAt: now + WINDOW_MS };
      rateBuckets.set(key, existing);
    }

    existing.count += 1;
    const bucket = existing;

    if (bucket.count > MAX_REQUESTS_PER_MINUTE) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            "X-RateLimit-Limit": String(MAX_REQUESTS_PER_MINUTE),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }

    // Optional Cron Secret gate for /api/cron/reminders in production.
    const cronSecret = process.env.CRON_SECRET;
    if (pathname.startsWith("/api/cron/")) {
      if (!cronSecret) {
        // Fail closed: an unauthenticated reminder sweep spends credits and
        // sends messages on the owner's behalf.
        return NextResponse.json(
          { error: "Cron is not configured: set CRON_SECRET." },
          { status: 503 }
        );
      }
      const authHeader = req.headers.get("authorization");
      if (authHeader !== `Bearer ${cronSecret}`) {
        return NextResponse.json(
          { error: "Unauthorized cron invocation." },
          { status: 401 }
        );
      }
    }

    const res = NextResponse.next();
    res.headers.set("X-RateLimit-Limit", String(MAX_REQUESTS_PER_MINUTE));
    res.headers.set(
      "X-RateLimit-Remaining",
      String(Math.max(0, MAX_REQUESTS_PER_MINUTE - bucket.count))
    );
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  }

  // Standard security headers for web app pages.
  const res = NextResponse.next();
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(self)"
  );
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
