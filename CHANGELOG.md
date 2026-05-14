# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-14

First post-submission iteration. The 2026-05-11 Colosseum Frontier submission shipped as 0.1.0 (implicit — no tag was cut at the time); 0.2.0 collects polish items that landed in the days around submission plus the post-submission engineering surface (architecture docs, CSV export). No runtime semantics change for existing agents.

### Added
- Repo-rooted [`ARCHITECTURE.md`](./ARCHITECTURE.md) with three mermaid diagrams — system context, transaction-flow sequence, and reasoning-tree shape — plus per-step file references. README now links it from the top section. ([17.1](./docs/TASKS.md))
- CSV export on the agent-detail Transactions card. Downloads the currently loaded paginated window as `transactions-<agent-slug>-<YYYY-MM-DD>.csv` with RFC 4180-style escaping; pure serializer lives in [`apps/dashboard/src/lib/tx-csv.ts`](./apps/dashboard/src/lib/tx-csv.ts) with nine unit tests. ([17.2](./docs/TASKS.md))
- Reasoning-aware alert rules in the detector — alerts can fire from reasoning-span context, not just on-chain tx state. ([`c27f73b`](https://github.com/PavloDereniuk/AgentScope/commit/c27f73b), P.8)

### Fixed
- `HTTPException.res` headers now propagate through the global error handler — idiomatic Hono `new HTTPException(429, { res: new Response(null, { headers: { 'Retry-After': '60' }})})` finally works. End-to-end test added on the OTLP rate-limit path. ([`3b102fd`](https://github.com/PavloDereniuk/AgentScope/commit/3b102fd), P.6)

### Security
- RLS enabled on every child partition of `agent_transactions` (`2026_04` through `2026_09` plus `_default`). Postgres does not inherit RLS from a partitioned parent, and PostgREST exposes each partition as its own `/rest/v1/<name>` endpoint — without per-partition `ENABLE ROW LEVEL SECURITY`, an anon/authenticated caller could hit a partition directly and bypass the parent's `tx_owner_access` policy. New migration `0010_rls_on_partitions.sql`; service-role ingestion (BYPASSRLS) untouched. ([`1ac359d`](https://github.com/PavloDereniuk/AgentScope/commit/1ac359d), P.11)

[Unreleased]: https://github.com/PavloDereniuk/AgentScope/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.2.0
