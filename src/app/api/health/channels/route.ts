import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/security/webhookAuth";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Channel readiness for uptime monitoring.
 *
 * Deliberately not on the public liveness endpoint: it names configured
 * channels. When VELNOR_HEALTH_SECRET is set the caller must present it and
 * receives the issue list; without a secret only a coarse status is returned.
 * No secret value is ever echoed.
 *
 * iMessage delivery runs through LoopMessage, VELNOR's only SMS/iMessage provider.
 */
export async function GET(req: Request) {
  let config: Record<string, unknown> = {};
  let storage: "ok" | "unavailable" = "ok";
  try {
    config = await withVelnorTenantScope("default", async () => {
      const { repository, tenantId } = getNodeTenantRepositoryContext();
      const record = await repository.load(tenantId);
      return (record?.state.config ?? {}) as Record<string, unknown>;
    });
  } catch {
    storage = "unavailable";
  }

  const healthSecret = process.env.VELNOR_HEALTH_SECRET;
  const authorized = healthSecret
    ? authorizeCronRequest(healthSecret, req.headers.get("x-velnor-health-secret")).ok
    : true;
  if (healthSecret && !authorized) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const loopMessage = Boolean(
    (typeof config.loopMessageAuthKey === "string" ? config.loopMessageAuthKey : "") ||
      process.env.LOOPMESSAGE_AUTH_KEY,
  );

  const channels = {
    loopmessage: loopMessage ? "ready" : "unconfigured",
  } as const;
  const healthy = storage === "ok" && channels.loopmessage === "ready";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      storage,
      channels,
      ...(authorized && healthSecret ? { issues: [] } : {}),
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
