import { NextRequest, NextResponse } from "next/server";

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 90;
const MAX_RATE_BUCKETS = 10_000;

function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const forwardedAddresses = forwardedFor?.split(",").map((address) => address.trim()).filter(Boolean);
  return forwardedAddresses?.at(-1) || req.headers.get("x-real-ip")?.trim() || "unknown";
}

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/health" ||
    pathname === "/api/vcard" ||
    pathname === "/api/webhooks/manifest" ||
    pathname.startsWith("/api/webhooks/") ||
    pathname === "/api/auth/google/callback";
}

function pruneRateBuckets(now: number): void {
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
  while (rateBuckets.size >= MAX_RATE_BUCKETS) {
    const oldest = rateBuckets.keys().next().value;
    if (oldest === undefined) break;
    rateBuckets.delete(oldest);
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Apply rate limiting to API routes
  if (pathname.startsWith("/api/")) {
    const sharedSecret = process.env.VELNOR_SHARED_SECRET || "";
    const requiresCronAuth = pathname.startsWith("/api/cron/");
    if (!isPublicApiPath(pathname) && !requiresCronAuth) {
      if (process.env.NODE_ENV === "production" && sharedSecret.length < 32) {
        return NextResponse.json(
          { error: "API authentication is not configured." },
          { status: 503 }
        );
      }

      if (sharedSecret && !safeEquals(
        req.headers.get("x-velnor-secret") ||
          req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          "",
        sharedSecret
      )) {
        return NextResponse.json(
          { error: "A valid Velnor API credential is required." },
          { status: 401 }
        );
      }
    }

    const ip = getClientIp(req);
    const now = Date.now();
    let existing = rateBuckets.get(ip);

    let bucket: RateBucket;
    if (!existing || now > existing.resetAt) {
      if (rateBuckets.size >= MAX_RATE_BUCKETS) pruneRateBuckets(now);
      bucket = { count: 1, resetAt: now + WINDOW_MS };
      rateBuckets.set(ip, bucket);
    } else {
      existing.count += 1;
      bucket = existing;
    }

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

    // Optional Admin Token gate for /api/settings mutation in production
    const adminToken = process.env.VELNOR_ADMIN_TOKEN || "";
    if (pathname === "/api/settings" && req.method === "POST") {
      if (process.env.NODE_ENV === "production" && adminToken.length < 32) {
        return NextResponse.json(
          { error: "Settings administration is not configured." },
          { status: 503 }
        );
      }
      const provided = req.headers.get("x-velnor-admin-token") || "";
      if (adminToken && !safeEquals(provided, adminToken)) {
        return NextResponse.json(
          { error: "Unauthorized: valid VELNOR_ADMIN_TOKEN required." },
          { status: 401 }
        );
      }
    }

    // Optional Cron Secret gate for /api/cron/reminders in production
    const cronSecret = process.env.CRON_SECRET || "";
    if (pathname.startsWith("/api/cron/")) {
      if (process.env.NODE_ENV === "production" && cronSecret.length < 32) {
        return NextResponse.json(
          { error: "Cron authentication is not configured." },
          { status: 503 }
        );
      }
      const authHeader = req.headers.get("authorization");
      if (cronSecret && !safeEquals(authHeader || "", `Bearer ${cronSecret}`)) {
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

  // Standard security headers for web app pages
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
