import { NextResponse } from "next/server";

const startedAt = Date.now();

/** Public liveness endpoint: expose no tenant, provider, database or usage data. */
export async function GET() {
  return NextResponse.json({
    status: "healthy",
    service: "velnor-assistant",
    version: "2.0.0",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
}
