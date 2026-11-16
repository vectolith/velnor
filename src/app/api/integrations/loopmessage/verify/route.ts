import { NextRequest, NextResponse } from "next/server";
import { verifyLoopMessageSender } from "@/lib/channels/loopmessage";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { withVelnorTenantScope } from "@/lib/store";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) {
    return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  }
  return withVelnorTenantScope(tenant.userId, async () => {
    const { repository, tenantId } = getNodeTenantRepositoryContext();
    const record = await repository.load(tenantId);
    const config = (record?.state as { config?: Record<string, unknown> } | undefined)?.config || {};
    const authKey = typeof config.loopMessageAuthKey === "string" && config.loopMessageAuthKey
      ? config.loopMessageAuthKey : process.env.LOOPMESSAGE_AUTH_KEY || "";
    const senderId = (process.env.LOOPMESSAGE_SENDER_ID || "").trim();
    if (!authKey || !senderId) {
      return NextResponse.json({
        verified: false,
        error: "LOOPMESSAGE_AUTH_KEY and LOOPMESSAGE_SENDER_ID must be configured.",
      }, { status: 503 });
    }
    const result = await verifyLoopMessageSender({ authKey, senderId });
    return NextResponse.json({
      verified: result.ok,
      senderId: result.senderId,
      senderName: result.name,
      providerStatus: result.status,
      imessageLink: result.imessageLink,
      detail: result.detail,
      appleIdEmailVerified: false,
    }, { status: result.ok ? 200 : 502 });
  });
}
