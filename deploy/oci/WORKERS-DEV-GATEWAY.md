# Free interim deployment: workers.dev identity gateway

This profile lets Velnor use the Cloudflare account's free `workers.dev` hostname while a custom domain is unavailable or its zone is still pending. It does **not** migrate the Node.js application onto Workers: the Next.js/Node.js service and its persistent SQLite data remain on the OCI VM.

Cloudflare describes `workers.dev` as suitable for personal or hobby projects, not business-critical production workloads. Treat this as a no-domain, free-tier interim route. Move to a custom domain when the zone is active.

## Endpoint

The connected account's workers.dev subdomain is `ganiyusail101`. The gateway URL for this Worker is:

```text
https://velnor-identity-gateway.ganiyusail101.workers.dev
```

Use this URL as `VELNOR_PUBLIC_URL` and as the public base URL for Velnor API integrations. Do not send client API requests directly to the OCI origin.

## Deploy the gateway

From `identity-gateway/`:

```bash
npx wrangler@4.160.0 deploy --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put CF_ACCESS_TEAM_DOMAIN --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put CF_ACCESS_AUD --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put VELNOR_ORIGIN --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put VELNOR_SHARED_SECRET --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put VELNOR_TENANT_TOKEN_SECRET --config wrangler.workers-dev.toml
npx wrangler@4.160.0 secret put VELNOR_PROVISIONING_SECRET --config wrangler.workers-dev.toml
```

Use the same generated `VELNOR_SHARED_SECRET`, `VELNOR_TENANT_TOKEN_SECRET`, and `VELNOR_PROVISIONING_SECRET` values on the OCI origin. Never commit these values or put them in Wrangler vars.

Set `VELNOR_ORIGIN` to the OCI VM's HTTPS `sslip.io` origin (not the workers.dev URL). Set `VELNOR_PUBLIC_URL` on the OCI app to the gateway URL above. The OCI service must listen behind Caddy on loopback only, with persistent `/app/.data` storage.

## Cloudflare Access policy

The gateway expects a Cloudflare Access JWT on private API paths. Configure hostname/path-based Access applications for the workers.dev URL:

1. Protect `velnor-identity-gateway.ganiyusail101.workers.dev/api/*` with an Allow policy restricted to the owner's exact email address.
2. Create more-specific Bypass applications for each public callback family: `/api/health`, `/api/webhooks/*`, `/api/cron/*`, and `/api/auth/google/callback`. These paths must remain reachable by external providers; the origin still verifies the gateway perimeter secret and each provider's signature/credential as applicable.
3. Do not create a Worker-wide Access policy for all traffic: it would block public provider callbacks unless the more-specific bypasses are in place.
4. Verify the effective policy order in Access before configuring provider callback URLs.

The application-path rule must be more specific than the protected `/api/*` application so the public callbacks use the bypass policy.

## Origin and provider configuration

- Set `VELNOR_PUBLIC_URL=https://velnor-identity-gateway.ganiyusail101.workers.dev` on the OCI service.
- Set the Google OAuth authorized redirect URI to `https://velnor-identity-gateway.ganiyusail101.workers.dev/api/auth/google/callback`.
- Point Slack, Twilio, Sendblue, and LoopMessage webhooks at the corresponding paths on the gateway URL.
- Keep the OCI application port bound to `127.0.0.1:8080`; expose only Caddy's HTTPS endpoint.
- Use long, unique secrets generated on the origin and copy them into the Worker's secret store through Wrangler. Do not reuse the provider credential-encryption key as an authentication secret.

## Verification gate

Before using the endpoint:

- Confirm the Worker is deployed and the hostname resolves.
- Confirm an unauthenticated request to a private API path is redirected to Access or rejected.
- Confirm an owner-authenticated request reaches the origin and receives a tenant-bound response.
- Confirm the public health endpoint is reachable without Access.
- Confirm webhook paths pass through the Worker and reject invalid provider signatures.
- Confirm direct-origin requests to protected API paths fail without the gateway perimeter secret.
- Confirm cron requests also require the independent `CRON_SECRET`.
- Run the repository CI and the deployment preflight on the OCI VM.

This profile does not provision an OCI VM, create Access applications, register Google OAuth callback URLs, configure provider webhooks, or generate origin secrets. Those steps require the relevant account credentials and live deployment environment.

## Switch to the custom domain later

After Cloudflare reports the `velnor.ai` zone as active and the registrar nameservers match the assigned Cloudflare nameservers, deploy the primary `wrangler.toml` profile and attach the custom route. Update `VELNOR_PUBLIC_URL`, Google OAuth, and provider webhook URLs together. Do not remove the workers.dev route until the custom route has passed the same verification gate.
