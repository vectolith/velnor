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
- `sub` as a provisioned Velnor tenant identifier
- `iat`, `nbf`, and `exp`; maximum token lifetime is 15 minutes

Set `VELNOR_TENANT_TOKEN_SECRET` to a cryptographically random secret of at least 32 characters. Keep it only in the authentication gateway and Velnor's secret manager. Never expose it to browsers, mobile apps, logs, or source control.

Example secret generation:

```sh
openssl rand -base64 48
```

The gateway must issue tokens only after validating the upstream session and mapping the authenticated account to a provisioned Velnor tenant. Do not create a token directly from a caller-supplied `sub`, `x-velnor-user`, request body, or URL parameter.

## Provisioning

The current resolver permits the reserved `owner` tenant and otherwise requires the subject to match an existing Velnor tenant profile. Provision tenant records through the trusted administrative provisioning path before issuing tokens.

## Important deployment limitation

This repository currently verifies signed identity tokens; it does not yet include a user sign-in UI, OAuth/OIDC callback, token-issuance endpoint, or a built-in Better Auth integration. A trusted gateway or identity service is therefore required before enabling multi-user production access. Do not deploy a client that signs its own tokens.

## API migration

Replace legacy `x-velnor-user` tenant selection with the bearer token. A shared `VELNOR_SHARED_SECRET` is still an outer deployment/API perimeter control in production; it is not a substitute for per-user identity.

## Operational requirements

- Use HTTPS for all control-plane requests.
- Keep identity tokens short-lived and rotate the signing secret through a coordinated gateway/Velnor rollout.
- Do not log bearer tokens.
- Revoke a user by disabling their upstream account and removing their Velnor tenant provisioning.
- Keep provider credentials tenant-scoped; do not put personal OAuth tokens in global environment variables for multi-tenant deployments.
