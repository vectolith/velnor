# Security release checklist

This checklist separates repository-level protections from controls that must be verified in the deployed environment.

## Required deployment configuration

- [ ] Configure the Cloudflare Access self-hosted application for the API hostname, an identity provider, and an explicit allow policy.
- [ ] Verify the Access application's exact AUD tag and team-domain issuer against the Worker variables.
- [ ] Set VELNOR_PUBLIC_URL to the canonical HTTPS origin used by Google OAuth and Twilio signature verification.
- [ ] Keep VELNOR_SHARED_SECRET, VELNOR_TENANT_TOKEN_SECRET, VELNOR_PROVISIONING_SECRET, VELNOR_SECRET_KEY, and CRON_SECRET distinct, randomly generated, and stored only in deployment secret managers.
- [ ] Restrict the OCI origin at both the VCN security list/NSG and host firewall: allow TCP 443 only from the required Cloudflare egress ranges; if TCP 80 is exposed for Caddy ACME, verify it cannot provide an alternate application route; keep 8080 loopback-only. Prove direct-origin API calls cannot bypass the Worker.
- [ ] Configure platform-edge/shared rate limiting for multi-instance deployments. The in-process limiter is only a per-instance abuse guard.
- [ ] Verify the identity gateway can reach the origin without routing back through its own public hostname.

## Security smoke tests

- [ ] Unauthenticated requests to /api/chat, /api/settings, /api/siri, /api/tts, and /api/lora-pilot are rejected.
- [ ] Cron GET and POST requests without both the gateway perimeter secret and correct CRON_SECRET are rejected even when sent directly to the origin.
- [ ] Direct-origin webhook and Google OAuth callback requests without the gateway perimeter secret are rejected; requests through the Worker receive an overwritten x-velnor-secret.
- [ ] Twilio, Slack, Sendblue, and LoopMessage callbacks reject missing, invalid, and stale credentials/signatures.
- [ ] A Google OAuth callback with altered, expired, or replayed state is rejected.
- [ ] Two distinct authenticated tenant identities cannot read or mutate each other's messages, documents, reminders, provider credentials, or OAuth state.
- [ ] Direct requests with spoofed X-Forwarded-For, X-Real-IP, Host, or forwarded-proto headers cannot change the canonical Twilio signature URL or trusted rate-limit identity.
- [ ] Oversized or chunked JSON bodies are rejected before buffering on chat, settings, Siri, TTS, tenant provisioning, cron, and provider webhook routes.
- [ ] A stale affirmative from an earlier conversation turn cannot authorize a newly requested sensitive action.

## Credential migration and rotation

- [ ] Deploy with VELNOR_SECRET_KEY configured so legacy plaintext provider credentials are resealed during tenant hydration.
- [ ] Verify SQLite and JSON recovery mirrors contain sealed credential values, not plaintext.
- [ ] After configuring VELNOR_SECRET_KEY, call the operator-only POST /api/internal/maintenance/reseal-credentials endpoint directly on the origin with x-velnor-provisioning-secret to sweep every tenant profile; verify the returned processed count and sealed values in SQLite and JSON mirrors.
- [ ] Rotate provider credentials if plaintext versions may exist in old backups, snapshots, logs, or external copies. Runtime migration cannot rewrite historical backups.
- [ ] Back up tenant data before changing encryption keys; key rotation requires a coordinated decrypt-and-reseal migration.

## Release gate

- [ ] Require the latest CI run to pass unit/regression tests, typecheck, production build, production-server verification, and identity-gateway bundle.
- [ ] Keep the security PR unmerged until the above deployment checks have evidence attached.
- [ ] Run an independent penetration test before describing the deployment as fully security-audited.
