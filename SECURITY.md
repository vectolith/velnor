# Security policy

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities in public issues. Contact the repository owner privately through GitHub's security reporting feature (Security > Advisories > Report a vulnerability) when available. Include affected versions, reproduction steps, impact, and a suggested mitigation if known.

## Scope and current security boundaries

- The IDE preview runs in a sandboxed iframe without same-origin privileges.
- Workspace data and provider keys are stored in the browser; local browser storage is not a secure vault.
- The assistant API accepts provider keys from the client or uses deployment environment configuration.
- The assistant endpoint's in-memory rate limiter is process-local and is not a substitute for edge-level or distributed abuse controls.
- Deployments should use HTTPS, restrict secrets, and configure the hosting proxy so client IP handling is trustworthy.

## Supported security checks

CI runs tests, type checking, production build and smoke checks, plus a scheduled npm audit for high/critical dependency advisories. These checks do not constitute a penetration test or guarantee security.
