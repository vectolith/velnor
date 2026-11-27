# Security and release readiness

This document distinguishes automated checks from controls that must be configured or tested at deployment.

## Automated checks

- [x] Unit tests and workspace path validation
- [x] TypeScript type checking
- [x] Next.js production build
- [x] Production server smoke test
- [x] Docker build and container smoke test
- [x] Dependency audit for high/critical vulnerabilities
- [x] Security headers configured in Next.js
- [ ] API route adversarial integration tests (malformed JSON, size limits, abuse/rate-limit behavior, upstream timeout and error handling)
- [ ] Browser-level iframe preview security tests

## Deployment checklist

- [ ] HTTPS enabled; HSTS is only meaningful when HTTPS is correctly deployed
- [ ] Secrets stored in deployment secret manager; never committed
- [ ] Provider endpoint is trusted and controlled (server-configured base URL can direct server requests)
- [ ] Edge/WAF rate limiting configured for assistant API
- [ ] Proxy IP headers are configured and trustworthy; do not use client-supplied forwarded headers as identity without proxy normalization
- [ ] Monitoring and alerting configured for errors, abuse and resource consumption
- [ ] Backup/restore and deployment rollback procedures exercised
- [ ] Security reporting channel is enabled and monitored
- [ ] Authentication/authorization requirements reviewed before adding shared or multi-user workspace features

## Known limits

The current assistant API rate limiter is process-local and can reset on process restart or be bypassed across multiple instances. The browser workspace and API key use local storage. The IDE is currently a browser-based workspace, not a server-side file persistence or multi-user service. CI and this checklist are not a substitute for a security review.
