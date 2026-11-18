# Security Policy

## Reporting a vulnerability

Do not publish exploit details, credentials, private keys, recovery phrases, or
proof-of-concept payloads in public issues or pull requests.

1. If GitHub's **Report a vulnerability** option is available in this repository's
   Security tab, use private vulnerability reporting.
2. If that option is not available, contact the repository owner privately
   through GitHub and request a private disclosure channel before sending
   technical details.

Include the affected commit or release, product surface, impact, prerequisites,
a minimal reproduction, and any suggested mitigation. Redact secrets and
personal data from logs, screenshots, and requests.

## Scope

Reports may cover authentication, authorization, cryptography, data exposure,
tenant isolation, unsafe parsing, dependency vulnerabilities, build/release
integrity, and deployment configuration in this repository.

Do not test against third-party services, accounts, wallets, homeservers,
production deployments, or other users' data without explicit authorization.
Do not perform destructive testing, denial-of-service testing, or social
engineering.

## Coordinated disclosure

Allow the maintainers reasonable time to validate and address a report before
public disclosure. No fixed response or remediation SLA is promised. Security
fixes and release notes will identify affected versions and mitigations when
available.

Never send passwords, API keys, private keys, recovery phrases, or live access
tokens as part of a report.
