# Security Policy

## Supported Versions

AgentScope is in pre-1.0 alpha. Only the `main` branch receives security updates.

| Version | Supported |
| ------- | --------- |
| `main`  | ✅        |
| < 1.0   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- **Email**: [derenyukpi@gmail.com](mailto:derenyukpi@gmail.com)
- **GitHub Security Advisories**: [Report a vulnerability](https://github.com/PavloDereniuk/agentscope/security/advisories/new)

We aim to:

- Acknowledge receipt within **72 hours**
- Provide a fix or mitigation plan within **7 days** for critical issues
- Publish a coordinated disclosure after the fix ships

## Scope

**In scope:**

- AgentScope API (`apps/api`) — auth, OTLP receiver, tx/alert routes
- Ingestion worker (`apps/ingestion`) — Yellowstone stream, parser dispatcher, detector
- Dashboard (`apps/dashboard`) — Privy auth, SSE consumer, data display
- SDK packages — `@agentscopehq/agent-kit-sdk`, `@agentscopehq/elizaos-plugin`
- Database schema and RLS policies (`packages/db`)
- Parser / detector / alerter logic (`packages/*`)

**Out of scope:**

- Third-party dependencies (report upstream to the maintainers)
- Infrastructure provider vulnerabilities (Supabase, Railway, Vercel, Helius, Privy) — report to the respective vendors
- Denial of service via rate-limit circumvention without a privilege escalation

## Disclosure

We follow coordinated disclosure. Please allow **7–30 days** between report and public disclosure so a fix can be released and adopted.

## Hall of Fame

Security researchers who report valid vulnerabilities will be credited in the release notes (unless anonymity is requested).
