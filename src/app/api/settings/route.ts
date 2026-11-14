import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_STATE,
  getEffectiveKeys,
  isValidSlackChannel,
  resolveSlackChannel,
  type VelnorState,
  withVelnorTenantScope,
} from "@/lib/store";
import type { PersistedTenantState } from "@/lib/storage/d1TenantState";
import { getNodeTenantRepositoryContext } from "@/lib/storage/currentTenantRepository";
import { authorizeChatTenant } from "@/lib/security/tenant";
import { PayloadTooLargeError, readRequestBodyLimited } from "@/lib/security/requestBody";

export async function GET(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  return withVelnorTenantScope(tenant.userId, async () => {
    const { repository, tenantId } = getNodeTenantRepositoryContext();
    const record = await repository.load(tenantId);
    return buildSettings((record?.state ?? DEFAULT_STATE) as unknown as VelnorState);
  });
}

function buildSettings(state: VelnorState) {
  const keys = getEffectiveKeys(state);
  return NextResponse.json({
    activeProvider: state.config.activeProvider,
    geminiModel: state.config.geminiModel,
    geminiImageModel: state.config.geminiImageModel,
    openaiModel: state.config.openaiModel,
    anthropicModel: state.config.anthropicModel,
    hasGeminiKey: Boolean(keys.geminiApiKey),
    hasOpenaiKey: Boolean(keys.openaiApiKey),
    hasAnthropicKey: Boolean(keys.anthropicApiKey),
    twilioFromNumber: state.config.twilioFromNumber || "",
    sendblueFromNumber: state.config.sendblueFromNumber || "",
    hasTwilio: Boolean(state.config.twilioAccountSid),
    hasSendblue: Boolean(state.config.sendblueApiKey),
    hasLoopMessage: Boolean(state.config.loopMessageAuthKey),
    hasSlack: Boolean(state.config.slackBotToken || process.env.SLACK_BOT_TOKEN),
    slackChannel: resolveSlackChannel(state),
    googleConnectedEmail: state.config.googleConnectedEmail || "",
    hasGoogleOAuth: Boolean(state.config.googleClientId && state.config.googleClientSecret),
  });
}

export async function POST(req: NextRequest) {
  const tenant = authorizeChatTenant(req.headers.get("authorization"));
  if (!tenant.ok) return NextResponse.json({ error: tenant.error }, { status: tenant.status ?? 401 });
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBodyLimited(req, 64 * 1024));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "JSON body must be an object." }, { status: 400 });
  }
  return withVelnorTenantScope(tenant.userId, () => updateSettings(body as Record<string, unknown>));
}

async function updateSettings(body: Record<string, unknown>) {
  const slackChannel = body.slackChannel === undefined ? undefined : String(body.slackChannel).trim();
  if (slackChannel !== undefined && !isValidSlackChannel(slackChannel)) {
    return NextResponse.json(
      { ok: false, error: "slackChannel must look like #channel-name or a channel id such as C0123456789" },
      { status: 400 }
    );
  }

  const { repository, tenantId } = getNodeTenantRepositoryContext();
  await repository.update(
    tenantId,
    () => structuredClone(DEFAULT_STATE) as unknown as PersistedTenantState,
    (draft) => {
      const state = draft as unknown as VelnorState;
      if (!state.config || typeof state.config !== "object") {
        state.config = structuredClone(DEFAULT_STATE.config);
      }

      if (typeof body.activeProvider === "string" && body.activeProvider) state.config.activeProvider = body.activeProvider;
      if (typeof body.geminiModel === "string" && body.geminiModel) state.config.geminiModel = body.geminiModel;
      if (typeof body.geminiImageModel === "string" && body.geminiImageModel) state.config.geminiImageModel = body.geminiImageModel;
      if (typeof body.openaiModel === "string" && body.openaiModel) state.config.openaiModel = body.openaiModel;
      if (typeof body.anthropicModel === "string" && body.anthropicModel) state.config.anthropicModel = body.anthropicModel;

      if (typeof body.geminiApiKey === "string" && body.geminiApiKey.trim()) state.config.geminiApiKey = body.geminiApiKey.trim();
      if (typeof body.openaiApiKey === "string" && body.openaiApiKey.trim()) state.config.openaiApiKey = body.openaiApiKey.trim();
      if (typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()) state.config.anthropicApiKey = body.anthropicApiKey.trim();

      if (typeof body.twilioAccountSid === "string") state.config.twilioAccountSid = body.twilioAccountSid.trim();
      if (typeof body.twilioAuthToken === "string") state.config.twilioAuthToken = body.twilioAuthToken.trim();
      if (typeof body.twilioFromNumber === "string") state.config.twilioFromNumber = body.twilioFromNumber.trim();
      if (typeof body.sendblueApiKey === "string") state.config.sendblueApiKey = body.sendblueApiKey.trim();
      if (typeof body.sendblueApiSecret === "string") state.config.sendblueApiSecret = body.sendblueApiSecret.trim();
      if (typeof body.sendblueFromNumber === "string") state.config.sendblueFromNumber = body.sendblueFromNumber.trim();
      if (typeof body.loopMessageAuthKey === "string") state.config.loopMessageAuthKey = body.loopMessageAuthKey.trim();
      if (typeof body.loopMessageSecretKey === "string") state.config.loopMessageSecretKey = body.loopMessageSecretKey.trim();
      if (typeof body.slackBotToken === "string") state.config.slackBotToken = body.slackBotToken.trim();
      if (typeof body.slackSigningSecret === "string") state.config.slackSigningSecret = body.slackSigningSecret.trim();
      if (slackChannel !== undefined) state.config.slackChannel = slackChannel;
      if (typeof body.googleClientId === "string") state.config.googleClientId = body.googleClientId.trim();
      if (typeof body.googleClientSecret === "string") state.config.googleClientSecret = body.googleClientSecret.trim();
    }
  );
  return NextResponse.json({ ok: true });
}
