# Velnor identity and tenant access

## Control-plane identity contract

The HTTP control plane does not accept a tenant identifier as proof of identity. Requests to `/api/chat`, `/api/settings`, and `/api/siri` must carry:

```http
Authorization: Bearer <short-lived-HS256-identity-token>
```

The token must be minted by a trusted authentication gateway after that gateway has authenticated the user. Velnor verifies:

- `alg=HS256` and `typ=JWT`
- HMAC-SHA256 signature using `VELNOR_TENANT_TOKEN_SECRET`
- issuer `VELNOR_TENANT_TOKEN_ISSUER` (default `velnor-auth`)
- audience `VELNOR_TENANT_TOKEN_AUDIENCE` (default `velnor-api`)
- `sub` as the authenticated upstream account subject
- optional signed `tenant_id` to map that account to an existing Velnor tenant partition
- `iat`, `nbf`, and `exp`; maximum token lifetime is 15 minutes

Set `VELNOR_TENANT_TOKEN_SECRET` to a cryptographically random secret of at least 32 characters. Keep it only in the authentication gateway and Velnor's secret manager. Never expose it to browsers, mobile apps, logs, or source control.

Example secret generation:

```sh
openssl rand -base64 48
```

The gateway must issue tokens only after validating the upstream session and mapping the authenticated account to a provisioned Velnor tenant. If `tenant_id` is omitted, Velnor uses `sub` as the tenant identifier. If `tenant_id` is present, it must match an existing Velnor partition; this supports mapping a verified account to a provider-created Slack or messaging tenant. Do not create a token directly from a caller-supplied `sub`, `tenant_id`, `x-velnor-user`, request body, or URL parameter.

## Provisioning

The current resolver permits the reserved `owner` tenant and otherwise requires the subject to match an existing Velnor tenant profile. Provision tenant records through the trusted administrative provisioning path before issuing tokens.

## Important deployment limitation

This repository currently verifies signed identity tokens; it does not yet include a user sign-in UI, OAuth/OIDC callback, token-issuance endpoint, or a built-in Better Auth integration. A trusted gateway or identity service is therefore required before enabling multi-user production access. Do not deploy a client that signs its own tokens.

## API migration

Replace legacy `x-velnor-user` tenant selection with the bearer token. A shared `VELNOR_SHARED_SECRET` is still an outer deployment/API perimeter control in production; it is not a substitute for per-user identity. Send it in `x-velnor-secret` because the `Authorization` header is reserved for the per-user bearer token.

## Operational requirements

- Use HTTPS for all control-plane requests.
- Keep identity tokens short-lived and rotate the signing secret through a coordinated gateway/Velnor rollout.
- Do not log bearer tokens.
- Revoke sign-in by disabling the upstream identity or removing/revoking the user in the Cloudflare Access policy/session. The gateway issues a new Velnor bearer token per request and each token expires after five minutes; it does not keep a separate refresh-token session.
- Revoking sign-in does not delete tenant data. Handle tenant-data deletion separately under the deployment's retention and recovery policy.
- Keep provider credentials tenant-scoped; do not put personal OAuth tokens in global environment variables for multi-tenant deployments.


## Google Workspace OAuth

- The authenticated `GET /api/auth/google` endpoint requires the same signed tenant bearer token as other control-plane APIs and returns an `authUrl` for the client to open.
- The OAuth state is HMAC-signed with `VELNOR_TENANT_TOKEN_SECRET`, bound to the tenant, expires after ten minutes, and is consumed once.
- The authorization-code flow uses PKCE (S256). The verifier is encrypted at rest.
- The callback stores access and refresh tokens inside the bound tenant partition. Refresh tokens and access tokens are encrypted with `VELNOR_SECRET_KEY`.
- Set `VELNOR_PUBLIC_URL` to the externally registered HTTPS origin so the callback URI remains stable behind reverse proxies.
- The callback is public by necessity, but it cannot select a tenant from caller input; it accepts only a valid signed state and matching one-time nonce.

## Built-in Cloudflare Access gateway

The repository includes a deployable Cloudflare Worker in `identity-gateway/`. It uses Cloudflare Access as the upstream sign-in boundary, so account authentication is handled by an identity provider configured in Cloudflare Access (for example Google, GitHub, or email one-time PIN). Velnor does not store user passwords.

The gateway performs these steps for protected `/api/*` requests:

1. Verify the `Cf-Access-Jwt-Assertion` signature against Cloudflare's published RS256 JWKS.
2. Validate the Access issuer, configured application audience, subject, and time claims.
3. Derive a stable, non-PII Velnor tenant ID by hashing the verified upstream subject.
4. Provision the tenant through the internal endpoint using a separate provisioning secret.
5. Mint a five-minute HS256 Velnor identity token and proxy the request with both the bearer token and deployment shared secret.

Webhook, cron, health, and the signed Google OAuth callback paths are intentionally passed through because external providers cannot present a user's Cloudflare Access assertion. The tenant provisioning endpoint is excluded from the gateway's user-auth flow but independently requires its dedicated secret.

### Configure and deploy

1. Create a Cloudflare Access self-hosted application for the Velnor API hostname. Configure at least one identity provider and an allow policy for the people who may use Velnor. The Worker must receive the Access JWT assertion header on protected API requests.
2. Ensure the Access policy does not block these provider-facing paths: `/api/webhooks/*`, `/api/cron/*`, `/api/health`, and `/api/auth/google/callback`. The Worker passes these paths to Velnor without adding a user identity.
3. Set the non-secret configuration in the Worker environment:
   - `CF_ACCESS_TEAM_DOMAIN`: your Cloudflare Access team domain, such as `https://example.cloudflareaccess.com`.
   - `CF_ACCESS_AUD`: the exact AUD tag for the Velnor Access application.
   - `VELNOR_ORIGIN`: the HTTPS origin of the Velnor deployment, without an API path. It must use a separate hostname from the public Worker route so internal provisioning and proxy requests do not recurse through the Worker.
   - `VELNOR_TENANT_TOKEN_ISSUER`: `velnor-auth`, unless Velnor is configured with another issuer.
   - `VELNOR_TENANT_TOKEN_AUDIENCE`: `velnor-api`, unless Velnor is configured with another audience.
4. Configure the following Worker secrets using Wrangler. Generate each secret independently with `openssl rand -base64 48`; do not reuse one secret for multiple purposes:
   - `VELNOR_SHARED_SECRET`: must match Velnor's `VELNOR_SHARED_SECRET`.
   - `VELNOR_TENANT_TOKEN_SECRET`: must match Velnor's `VELNOR_TENANT_TOKEN_SECRET`.
   - `VELNOR_PROVISIONING_SECRET`: must match Velnor's `VELNOR_PROVISIONING_SECRET`.
5. Configure the same three secrets in Velnor's deployment secret manager. Keep them out of source control and browser bundles.
6. In the Cloudflare dashboard, set the non-secret Worker variables under Workers & Pages → `velnor-identity-gateway` → Settings → Variables and Secrets. Use the exact values for `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and `VELNOR_ORIGIN`.
7. From the repository root, upload each Worker secret:
   ```sh
   npx wrangler secret put VELNOR_SHARED_SECRET --config identity-gateway/wrangler.toml
   npx wrangler secret put VELNOR_TENANT_TOKEN_SECRET --config identity-gateway/wrangler.toml
   npx wrangler secret put VELNOR_PROVISIONING_SECRET --config identity-gateway/wrangler.toml
   ```
8. Deploy with `npx wrangler deploy --config identity-gateway/wrangler.toml`, then bind the Worker to the Velnor API hostname using a Cloudflare route. Test login and tenant isolation before enabling broad Access policies.

The internal provisioning route accepts only tenant IDs in the deterministic `cf-<64 lowercase hex characters>` format. It is idempotent and refuses requests without `VELNOR_PROVISIONING_SECRET`. Do not expose that secret to clients.

### Security and rollout notes

- The Worker overwrites inbound `Authorization` and `x-velnor-secret` headers; clients cannot choose a Velnor tenant by sending their own identity claims.
- The Worker removes the Cloudflare assertion and provisioning-secret headers before forwarding requests to Velnor. Its Wrangler configuration disables the public `workers.dev` endpoint and preview URLs, and preserves dashboard-managed variables across redeploys; bind only the intended API hostname route.
- Velnor still validates the minted token independently. Keep the signing secret identical only between the Worker and Velnor.
- Restrict direct access to the Velnor origin at the network/platform layer. Protected handlers independently validate short-lived tenant JWTs; the shared secret is an outer perimeter control, not a replacement for origin isolation. For Cloud Run, do not assume `--allow-unauthenticated` makes the Worker the only ingress path; configure Cloud Run ingress or an authenticated origin hop if strict gateway-only access is required.
- The Worker caches successful tenant provisioning for up to five minutes per isolate. If a tenant is removed, Velnor's own provisioned-tenant check rejects the next request after the cache expires.
- The Worker currently supports Cloudflare Access as the authentication gateway. Other OIDC providers can be added behind the same verified-subject contract without changing Velnor's tenant authorization logic.
- This is an initial gateway implementation, not proof of a production rollout. Complete the Cloudflare Access configuration, secret setup, HTTPS origin restrictions, and real browser login tests before production use.

