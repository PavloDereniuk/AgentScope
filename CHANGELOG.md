# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-05-25

Low wallet-balance alert. Second post-hackathon roadmap release. Adds `low_balance` — a cron-triggered detector rule that fires once per agent per 60s cycle when the wallet's SOL balance drops below a configurable threshold (default 0.005 SOL warning, 0.001 SOL critical). Balance is read through an injected `BalanceFetcher` wrapped around Helius `Connection.getBalance` with a 25s per-wallet TTL cache and in-flight coalescing, so multiple balance-aware rules in the future share one RPC per cycle. RPC failures abstain silently — a Helius blip never looks like a fleet-wide bankrupt-wallet event.

### Added
- `low_balance` detector rule (TDD, 13 tests). Cron-only — runs alongside `drawdown` / `stale_agent` / `error_rate` / `ghost_execution`. Severity `warning` when balance < threshold, escalating to `critical` at one-fifth (threshold / 5 — picked so the default 0.005 SOL warning hits critical at 0.001 SOL, the practical floor where the next priority-fee bump bricks the agent). 1h dedupe window prevents duplicate inserts every 60s cycle while the condition persists.
- Balance-fetcher helper [`apps/ingestion/src/balance-fetcher.ts`](./apps/ingestion/src/balance-fetcher.ts) — HTTP-only `Connection.getBalance` with per-wallet TTL cache (25s) and in-flight coalescing. PublicKey constructor errors and RPC throws both swallow into `null` so a bad agent row or RPC outage never crashes the cron loop. Seven unit tests with mocked Connection.
- `BalanceFetcher` type exported from `@agentscope/detector`; `CronRuleContext.fetchAgentBalance?` injection point lets the rule consume the lookup while staying RPC-agnostic in unit tests. `AgentSnapshot` gains an optional `walletPubkey: string` so the rule can address the wallet without re-querying the DB.
- Shared format-alert mappings for `low_balance` — title ("Wallet Running Low"), summary, detail rows (balance / warning / critical), impact, and action lines. Dashboard + Telegram render identical copy.
- Settings → Notifications → "Low balance" row joins the existing rules with per-agent threshold override (`lowBalanceSolThreshold`, default 0.005 SOL). Per-rule pause from 0.3.0 works for the new rule out of the box.

### Schema
- Migration `0012_low_balance.sql` — `ALTER TYPE alert_rule_name ADD VALUE IF NOT EXISTS 'low_balance'`. Backwards-compatible; existing rows untouched.
- `AlertRuleThresholds.lowBalanceSolThreshold` (optional, positive). `DefaultThresholds.lowBalanceSol` defaults to 0.005 across `apps/ingestion/src/index.ts` + the trigger/seed scripts (env override `AGENTSCOPE_LOW_BALANCE_SOL_THRESHOLD`).

### Notes
Cron RPC cost is bounded: one `getBalance` per agent per 60s cycle, with a 25s cache that coalesces same-cycle reads. At 20 active agents that's ~20 req/min — well inside the Helius free tier's 100 req/sec cap. Full repo gate: lint 273 files clean, typecheck 18/18 packages, test 18/18 turbo tasks (~360+ tests including 13 new low-balance + 7 balance-fetcher).

## [0.4.0] - 2026-05-22

MEV sandwich detection. First post-hackathon roadmap release. Adds `slippage_sandwich` — a new tx-triggered detector rule that flags Jupiter swaps where the agent received noticeably less than the route quoted. Ships in two layers: an evidence-only check (actual vs. quoted output from the swap's own `tokenDeltas`) and a slot-neighbour confirmation step that queries `getBlock(slot)` for a higher-priority-fee Jupiter swap landing beside the victim. Confirmed front-runners escalate severity warning → critical. RPC failures degrade gracefully to evidence-only output — sandwich alerts never silently disappear during a Helius outage.

### Added
- `slippage_sandwich` detector rule (TDD, 24 tests). Distinct from `slippage_spike`: that rule guards on the swap's own `slippageBps` intent, this one reads actual vs. quoted output — so it catches MEV attacks that operate *within* the slippage cap. ([`19cf1c7`](https://github.com/PavloDereniuk/AgentScope/commit/19cf1c7), A.1 Phase 1)
- Slot-neighbour lookup helper [`apps/ingestion/src/slot-neighbours.ts`](./apps/ingestion/src/slot-neighbours.ts) — HTTP-only `Connection.getBlock` with per-slot TTL cache (30s) and in-flight coalescing so multiple swaps in the same block share one RPC call. FIFO eviction at 256 slots keeps memory bounded. Six unit tests with mocked Connection. ([`71b6dc7`](https://github.com/PavloDereniuk/AgentScope/commit/71b6dc7), A.1 Phase 2)
- `SlotNeighbourTx` + `NeighbourFetcher` types exported from `@agentscope/detector`; `TxRuleContext.fetchSlotNeighbours?` injection point lets rules consume the lookup while staying RPC-agnostic in unit tests. ([`71b6dc7`](https://github.com/PavloDereniuk/AgentScope/commit/71b6dc7))
- Shared format-alert mappings for `slippage_sandwich` — title ("MEV Sandwich Suspected"), summary, detail rows (quoted vs. received raw, output mint, front-runner sig + fee when confirmed), impact, and action lines. Dashboard + Telegram render identical copy. ([`19cf1c7`](https://github.com/PavloDereniuk/AgentScope/commit/19cf1c7))
- Settings → Notifications → "MEV sandwich" row joins the existing eight rules with per-agent threshold override (`sandwichSlippagePctThreshold`, default 2%). Per-rule pause from 0.3.0 works for the new rule out of the box. ([`19cf1c7`](https://github.com/PavloDereniuk/AgentScope/commit/19cf1c7))

### Schema
- Migration `0011_slippage_sandwich.sql` — `ALTER TYPE alert_rule_name ADD VALUE IF NOT EXISTS 'slippage_sandwich'`. Backwards-compatible; existing rows untouched.
- `TxSnapshot` gains `slot: number` + `tokenDeltas: readonly TokenDelta[]` — required by the new rule, additive for the other seven (`tokenDeltas: []` is a valid default when no SPL movement happened).
- `AlertRuleThresholds.sandwichSlippagePctThreshold` (optional, positive). `DefaultThresholds.sandwichSlippagePct` defaults to 2 across `apps/ingestion/src/index.ts` + the trigger/seed scripts.

### Notes
The Phase 2 RPC dependency runs only when a swap *already* trips the evidence threshold — no wasted `getBlock` calls on healthy swaps. Failed neighbours, lower-fee neighbours, non-Jupiter programs, and self-matches are all filtered defensively. Full repo gate: lint 269 files clean, typecheck 18/18 packages, test 18/18 turbo tasks (~340+ tests including 24 new sandwich + 6 slot-neighbour). SDK packages untouched.

## [0.3.0] - 2026-05-19

Per-rule alert silencing. Datadog/PagerDuty-style: mute a single rule (e.g. `slippage_spike` while you tune an arbitrage strategy) without muting the whole agent. Builds on the agent-wide pause from 0.2.0 — both layers compose through one shared dispatcher so detector and cron behave identically. No database migration; the new `pausedUntil` map lives inside the existing `alert_rules` jsonb column, fully backwards-compatible with rows that omit it.

### Added
- Per-rule pause map `AlertRuleThresholds.pausedUntil: Partial<Record<AlertRuleName, string>>` — keys are enum-validated against `AlertRuleName`, values are ISO-8601 timestamps. Past values auto-resume. Shared helper `isRulePaused(thresholds, ruleName, now)` mirrors the global `isAlertsPaused` semantics. ([`379d4a8`](https://github.com/PavloDereniuk/AgentScope/commit/379d4a8), 18.1)
- Shared `pickDeliveryAction(thresholds, globalPausedUntil, ruleName, now)` dispatcher with three outputs (`'deliver'` / `'skip-rule-paused'` / `'skip-paused'`). Global pause wins on collision so the dashboard "Paused" badge cannot be contradicted by a per-rule entry stuck in the past. ([`f46c493`](https://github.com/PavloDereniuk/AgentScope/commit/f46c493), 18.2)
- Detector + cron now partition each cycle's results into skip-vs-deliver via the dispatcher. Skipped rows still land in `alerts` with `delivery_status='skipped'` + the channel that *would* have been used — full audit trail preserved, sender never invoked. ([`f46c493`](https://github.com/PavloDereniuk/AgentScope/commit/f46c493), 18.2)
- Settings → Notifications card → "Per-rule pause" list of all 8 alert rules with native preset selects (1h / 24h / 7d / Forever) and inline Resume buttons. Agent-detail header gets a softer `<RulesPausedBadge>` alongside the existing `<PausedBadge>`. ([`d722176`](https://github.com/PavloDereniuk/AgentScope/commit/d722176), 18.3)
- Dashboard helper [`apps/dashboard/src/lib/format-paused.ts`](./apps/dashboard/src/lib/format-paused.ts) — `formatPausedUntil(iso, now)` returns `''` / `'indefinitely'` / `'23h 12m'` / `'Jul 18 2026, 12:00 UTC'` (deadline-aware fallback at 60 days). Eight unit tests. Global pause UI refactored to use it so both layers share one duration vocabulary. ([`d722176`](https://github.com/PavloDereniuk/AgentScope/commit/d722176), 18.3)

### Notes
No DB migration. Legacy agent rows without `pausedUntil` keep behaving identically — the dispatcher returns `'deliver'` for empty thresholds. SDK packages (`@agentscopehq/*`) untouched. ~18 new tests across `shared`, `ingestion`, `api`, `dashboard` (full repo ~506 green).

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

[Unreleased]: https://github.com/PavloDereniuk/AgentScope/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.4.1
[0.4.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.4.0
[0.3.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.3.0
[0.2.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.2.0
