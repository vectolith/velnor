import { NextRequest, NextResponse } from "next/server";

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 90;

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1"
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Apply rate limiting to API routes
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(req);
    const now = Date.now();
    const existing = rateBuckets.get(ip);

    let bucket: RateBucket;
    if (!existing || now > existing.resetAt) {
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
    const adminToken = process.env.VELNOR_ADMIN_TOKEN;
    if (adminToken && pathname === "/api/settings" && req.method === "POST") {
      const provided =
        req.headers.get("x-velnor-admin-token") ||
        req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (provided !== adminToken) {
        return NextResponse.json(
          { error: "Unauthorized: valid VELNOR_ADMIN_TOKEN required." },
          { status: 401 }
        );
      }
    }

    // Optional Cron Secret gate for /api/cron/reminders in production
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && pathname.startsWith("/api/cron/")) {
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
