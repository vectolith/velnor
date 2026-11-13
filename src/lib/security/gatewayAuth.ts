export interface GatewayAuthDecision {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Edge-runtime-safe verifier for the dedicated gateway perimeter secret. */
export function authorizeGatewayRequest(
  secret: string | undefined,
  provided: string | null | undefined
): GatewayAuthDecision {
  if (!secret || secret.length < 32) {
    return { ok: false, status: 503, error: "Gateway perimeter authentication is not configured." };
  }
  if (!provided || provided.length !== secret.length) {
    return { ok: false, status: 401, error: "Request must pass through the trusted API gateway." };
  }
  let diff = 0;
  for (let index = 0; index < secret.length; index += 1) {
    diff |= secret.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  if (diff !== 0) {
    return { ok: false, status: 401, error: "Request must pass through the trusted API gateway." };
  }
  return { ok: true };
}
