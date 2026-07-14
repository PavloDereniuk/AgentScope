# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Drift v2 perpetuals parser** (A.6) — the classic order instructions an agent emits through the standard `@drift-labs/sdk`: `place_perp_order`, `place_orders`, `place_and_take_perp_order`, `cancel_order`, `cancel_orders`, plus collateral `deposit`/`withdraw`. Perp orders expose the semantics that matter for observability: `orderType` (market/limit/…), `direction` (long/short), `marketIndex`, `baseAssetAmount`, `price`, `reduceOnly`, and the resolved `userAccount` + `authority`. Discriminators and the `OrderParams` Borsh layout were verified against the official Drift IDL from **two** authoritative sources — the on-chain Anchor IDL account (v2.150.0) and `github.com/drift-labs/protocol-v2` (v2.162.0); the program state PDA (`5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN`) was confirmed on-chain as owned by the program. Every field the parser reads sits at a fixed offset **before** the first `Option` field in `OrderParams`, so decoding is correct for any real order regardless of which trailing options it sets. 13 TDD tests, 9 fixtures.
- **Scope + fixture note (A.6):** the parser intentionally does **not** decode Drift's keeper-side `fill_*` / Swift signed-message instructions — those are submitted by Drift's keepers rather than the observed agent, and the dominant ones are not even in the published IDL. As of 2026-07 Drift's mainnet order flow has migrated almost entirely to Swift, so classic outer place/cancel calls are absent from every pagination-reachable window (a scan of >6000 recent tx found zero). The committed fixtures are therefore constructed to the official IDL layout, not captured live; `scripts/fetch-drift-fixtures.ts` keeps the best-effort live-capture path for when a monitored agent emits classic calls.
- **Marinade Finance liquid-staking parser** (A.7) — `deposit`, `liquid_unstake`, `order_unstake`, and `claim` all parsed. Since staking only ever moves SOL ↔ mSOL (no arbitrary token pair to resolve), args stay flat: `amountLamports`/`msolAmount` + `stateAddress`, rather than the swap-style `{inputMint, outputMint}` shape used by the DEX parsers. `claim` carries no numeric arg (the amount lives in the ticket account) — instead exposes `reservePda` + `ticketAccount`. 12 TDD tests, 6 mainnet fixtures (2 deposit, 2 liquid_unstake, 1 order_unstake, 1 claim).
- **Program ID correction:** the Marinade address previously drafted in `POST-MVP-ROADMAP.md` (`MarBmsSgKXdrN1egZf5sqe1TMThiYsCfVuvAJBbQNTQ`) does not exist on mainnet (`getAccountInfo` → null). Verified the real program ID (`MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`) against `docs.marinade.finance/developers/contract-addresses` and a live `getAccountInfo` call before writing any parser code.

## [0.5.1] - 2026-07-01

### Added
- **Orca Whirlpools swap parser** (A.5) — all four Whirlpool instructions parsed: `swap` (v1, 11 accounts), `swap_v2` (15+ accounts, Token-2022 compatible), `two_hop_swap`, `two_hop_swap_v2`. Emits `orca.swap` / `orca.two_hop_swap` with `inputMint`, `outputMint`, amounts, `aToB`, `poolId`, and `variant` discriminating v1 vs v2. Mint resolution: token-account balance map for single-pool swaps (both variants); `ownerSpentMints`/`ownerGainedMints` net-flow fallback for two-hop variants. 11 TDD tests, 5 mainnet fixtures. Brings DEX coverage to Jupiter + Raydium + Orca + Kamino — >90% of Solana DEX volume.

## [0.5.4] - 2026-06-18

### Added
- **`priority_fee_spike` detector rule** (A.8) — tx-triggered, per-program ComputeBudget overpay detection. Unlike `gas_spike` (which compares a fee against the agent-wide 24h median), this rule compares the fee against the 24h median for the **same program** on this agent. Catches the class of bug where a misconfigured `ComputeBudget` instruction silently inflates fees on one protocol without moving the agent-wide baseline enough to trigger `gas_spike`. Warning fires above threshold (default 10×); critical fires at 5× threshold (50×). Abstains when `programId` is absent (legacy paths) or when the agent has no prior history for that program. 9 TDD integration tests covering: default threshold, within-threshold skip, per-agent override, critical escalation, program isolation (other program's median does not pollute), missing `programId`, missing history, misconfig guard, and dedupe key. Per-agent override via `priorityFeeMultThreshold` in the dashboard Settings → Alert Thresholds. DB migration `0015` adds the enum value. (A.8)
- **`programId` field in `TxSnapshot`** (optional) — `persist.ts` now forwards the primary program ID from each transaction into the detector snapshot, enabling per-program rules to query program-scoped historical data.

## [0.4.10] - 2026-06-15

### Added
- **Onboarding checklist** on agent-detail replaces the single-line "Step 2" activation banner. Three steps: *Agent registered* (always done) → *Wire up your agent* (shows `npm i @agentscopehq/agent-kit-sdk` + per-agent token with a copy button) → *Awaiting first trace* (auto-checks when the agent sends its first span). Warn-tint while pending, accent-tint on completion. Auto-dismisses 2.5 s after traffic arrives so the user briefly sees the all-green state. Manually dismissible; state persisted in `localStorage`. ([`95880b1`](https://github.com/PavloDereniuk/AgentScope/commit/95880b1), C.0c)

---

### Added
- **Owner-only admin / grant-ops panel** (Cluster F — `/admin` in the dashboard, 14 API tests). Unlike the per-user dashboard (Privy + RLS scoped to `user_id`), the admin surface aggregates platform-wide metrics across every builder, for reporting the Solana Foundation Ukraine grant milestones (M1=4 → M2=10 → M3=25 builders, deadline 2026-08-01). The hero is milestone progress tracked under **two** builder definitions side by side: *registered* (distinct users with ≥1 agent) and *active* (≥1 transaction or reasoning span) — the owner files whichever is appropriate per milestone. Plus: a builder-growth chart (30d), infra headroom (DB size vs the Supabase 500 MB cap with a days-to-cap projection, Helius monitored-agents vs the ~23-agent credit ceiling, ingest lag), a per-builder engagement table (active/dormant), and an alerts breakdown by rule × severity.
- **`GET /api/me`** → `{ isOwner }` — lets the dashboard reveal the `/admin` nav and guard the route without ever shipping the owner DID list to the client bundle (the server stays the single source of truth).

### Security
- New `requireOwner` middleware gates every `/api/admin/*` route. It layers on top of `requireAuth` and checks membership of the existing `OWNER_PRIVY_DID_SET` (the same allowlist that already bypasses `MAX_AGENTS_PER_USER`) — non-owners get a flat `403` with no body, so the admin endpoint set is not enumerable. Deliberately not an RBAC system: AgentScope is single-owner; SSO/RBAC stays out of scope.
- **RLS on every `agent_transactions` partition + `current_user_id()` hardening** (migration `0014`). The Supabase security advisor flagged the partition children (`agent_transactions_2026_04..09`, `_default`) as *RLS Disabled in Public*: Postgres does not propagate a parent's RLS to its partitions, and Supabase PostgREST exposes each partition as its own `/rest/v1/<name>` endpoint, so an anon/authenticated caller could read tx rows directly, bypassing `tx_owner_access`. Migration `0010` had enabled RLS on the initial six, but a `db:push`-based prod history never runs raw-SQL migrations, so prod was left exposed. `0014` re-enables RLS idempotently across **all** current partitions (a `pg_inherits` loop, so it also covers any months already rolled forward) and pins `current_user_id()`'s `search_path` (advisor *Function Search Path Mutable*). Enabling RLS with no partition-level policies is default-deny for non-`BYPASSRLS` roles only — the API and ingestion roles bypass RLS, so reads/writes are unaffected. **`ensureFuturePartitions` now enables RLS on each partition right after `CREATE`**, so the fix can't regress month over month (the gap migration `0010` warned about in a comment but left to manual follow-up). Apply to prod via the Supabase SQL editor (raw SQL, not reachable by `db:push`).

### Config
- `ADMIN_MILESTONE_TARGETS` (api, default `4,10,25`) — comma-separated milestone ladder, parsed + sorted ascending at boot.
- `ADMIN_MILESTONE_DEADLINE` (api, default `2026-08-01`) — ISO deadline shown with a countdown.

### Notes
Admin aggregations mirror the `routes/stats.ts` style (parallel `Promise.all`, `generate_series` for dense daily series) but omit the per-user filter — the API connection scopes ownership in application code, not RLS, so cross-user reads are a query change, not an RLS bypass. `pg_database_size` is wrapped so a permission/driver hiccup degrades the DB-size field to `null` rather than 500-ing the whole panel. No new dependencies, no schema change. Frontend reuses the existing `Kpi`/`KpiRow`, Recharts, and dark OKLCH styling. The panel loads through a single consolidated `GET /api/admin/summary` (the six per-section endpoints remain for granular use) that runs the aggregate groups **sequentially** server-side — six parallel browser requests were saturating the API's 5-connection pool and stalling the page. The `/builders` tx-join is bounded to 30 days so it prunes to recent partitions instead of scanning the whole (growing) table.

- **Automatic partition maintenance** for `agent_transactions` ([`apps/ingestion/src/partition-maintenance.ts`](./apps/ingestion/src/partition-maintenance.ts), 8 tests). The ingestion worker now rolls monthly partitions forward on a daily timer (and an immediate pass on boot). This closes a latent gap: migration `0001` only seeded partitions through 2026-09 with a TODO to add a maintenance job — without it, every transaction after 2026-10-01 would have silently fallen into the DEFAULT partition, defeating partition pruning and making retention drops impossible. That window is exactly the grant's M3 (Oct–Dec 2026), so this is a prerequisite for staying inside the Supabase free-tier 500 MB cap at 25-builder / 50-agent scale.
- **Opt-in TTL retention** for old tx partitions. When `TX_RETENTION_MONTHS > 0`, the same maintenance pass drops monthly partitions older than the window (`DROP TABLE`, reclaiming storage immediately). Disabled by default (`0`) — dropping a user's transaction history is a deliberate product decision, not a silent default. The DEFAULT partition is never dropped (regex-guarded), proven by test.

### Config
- `PARTITION_MONTHS_AHEAD` (ingestion, default `3`) — months of partitions to pre-create.
- `TX_RETENTION_MONTHS` (ingestion, default `0` = disabled) — retention window for TTL drops.

### Notes
Roll-forward is purely additive and idempotent (`CREATE TABLE IF NOT EXISTS … PARTITION OF`), safe on every boot. Cross-driver result-shape handling mirrors `apps/api/src/routes/stats.ts` (postgres-js vs pglite). Requires the ingestion `DATABASE_URL` role to hold DDL rights on `agent_transactions` (default Supabase `postgres` role does); on a restricted role the worker logs a warning and rows fall back to the DEFAULT partition without blocking ingestion. Gate: ingestion lint clean, typecheck clean, test 49/49 (8 new).

### Fixed
- **DB-hang after API redeploy** (E.7 — [`packages/db/src/client.ts`](./packages/db/src/client.ts)). After every Railway redeploy the old API container lingered long enough for the new container + ingestion to exceed Supabase's free-tier connection limit, stalling all `/api/*` queries for ~30 s while `/health` stayed green (direct TCP, not pooled). Root cause: postgres.js defaults to server-side prepared statements, which pgbouncer in *transaction-pooler mode* (Supabase port 6543) does not support — the driver and pgbouncer negotiated connections that never cleanly handed off, leaving stale server-side state in the pool. Fix: `createDb` now auto-detects port 6543 in the connection string and passes `prepare: false` to postgres.js, which disables prepared statements for that client. No change for direct connections (port 5432) or PGlite test harnesses — they are unaffected by this detection. The `prepare` field is also exposed as an explicit override on `DbConfig` for future callers that need to override the auto-detection. No schema change, no new deps. Effective on the next Railway redeploy once `DATABASE_URL` points at the pooler (port 6543 — the default in `.env.example`).

### Changed
- **Compact `parsed_args._all` outline** (E.5 — [`apps/ingestion/src/persist.ts`](./apps/ingestion/src/persist.ts), +3 tests). The per-row `_all` instruction list now keeps only `index` + `programId` + `name` for each instruction, dropping the full per-hop `args` it used to carry (`compactInstructionOutline`). Those args duplicated the primary instruction's args (already stored at the top level of `parsed_args`) and, on multi-hop Jupiter routes, piled every leg's `route_plan` into the jsonb — for data nothing reads: the dashboard tx-drawer doesn't surface `parsedArgs` at all, and detector rules consume only the top-level primary args. The outline still answers "which instructions ran". ~15–20% less `parsed_args` volume on swap-heavy agents, on top of the E.2 rawLogs diet. No schema change (jsonb column, same shape), no new deps. Gate: ingestion test 68/68 (+3), lint + typecheck clean across all 18 packages.
- **rawLogs storage diet** (E.2 — [`apps/ingestion/src/persist.ts`](./apps/ingestion/src/persist.ts), 8 tests). Persisted `raw_logs` now caps asymmetrically by outcome instead of a flat 200 lines: **20 on success, 200 on failure** (`capRawLogs` + `RAW_LOGS_LIMIT_SUCCESS`/`RAW_LOGS_LIMIT_FAILURE`). `raw_logs` is the single biggest contributor to the ~2.5 KB/tx footprint — Jupiter swaps routinely emit 500–2000 log lines, and the dashboard rarely inspects them line-by-line on the happy path (full logs stay available via RPC). Failed txs keep the fuller head+tail slice where the log tail *is* the primary diagnostic. On a success-heavy agent this cuts stored log volume ~10× on the big swaps and ~2.5× across the table, stretching the same Supabase free-tier footprint to ~26 days of retention at the grant's 50-agent M3 scale. No schema change (jsonb column, same shape), no new deps. Gate: ingestion test 65/65 (8 new), lint + typecheck clean across all 18 packages.

## [0.4.3] - 2026-06-01

Batched wallet-balance lookups. First Cluster E (infra-hardening) release and the single most credit-saving change for free-tier scaling. The cron previously issued one Helius `getBalance` per agent per 60s cycle for the `low_balance` rule — the 25s cache TTL is deliberately shorter than the cycle, so it never hit between cycles and the calls could not batch. At 50 agents that was ~2.16M credits/month from `getBalance` alone, blowing the Helius free-tier 1M cap and capping the platform at ~23 agents (see `docs/INFRA-CAPACITY.md`). Now the cron primes the whole fleet in one chunked `getMultipleAccounts` call per cycle and every per-agent read hits the warm cache: ⌈agents/100⌉ RPC calls per cycle — one call up to 100 agents, a ~50× cut. This is the prerequisite for the grant's M3 (50 agents) staying inside the free tier.

### Changed
- [`apps/ingestion/src/balance-fetcher.ts`](./apps/ingestion/src/balance-fetcher.ts) — `createBalanceFetcher` now returns `{ fetch, primeBalances }`. `primeBalances(wallets)` batches the fleet into chunked `getMultipleAccountsInfo` calls (100 keys/call cap), dedupes wallets, and populates the shared TTL cache. `fetch` is unchanged (the single-wallet `BalanceFetcher` the `low_balance` rule consumes) and still falls back to an individual `getBalance` on a cache miss, so nothing breaks when priming is absent (tests, dry runs).
- [`apps/ingestion/src/cron.ts`](./apps/ingestion/src/cron.ts) — `runCronCycle` collects every agent `walletPubkey` and calls `primeBalances` once at the start of each cycle (new optional `CronDeps.primeBalances`), before the per-agent rule loop reads the warm cache.
- [`apps/ingestion/src/index.ts`](./apps/ingestion/src/index.ts) — wires `balanceFetcher.fetch` + `balanceFetcher.primeBalances` into the cron.

### Notes
Fallback-abstain is preserved end-to-end: a thrown batch RPC caches `null` (unknown) for the affected wallets so `low_balance` abstains for that cycle — it never silently fans back out into N individual `getBalance` calls. Deliberate asymmetry vs. a missing account: in a *successful* response a `null` account entry means the wallet does not exist on-chain → 0 SOL (a genuine empty-wallet signal the rule should see), whereas a thrown error → `null` (abstain). The detector's `BalanceFetcher` contract stays single-wallet — the batch lives entirely in the ingestion layer (priming a shared cache) rather than reshaping the per-agent rule, which keeps `low_balance` simple and RPC-agnostic. No schema change, no new deps. Gate: ingestion lint clean (28 files), typecheck clean, test 56/56 (+6 batch-prime in balance-fetcher, +1 cron); full repo lint 277 clean, typecheck 18/18, test 18/18 turbo.

## [0.4.2] - 2026-05-29

Runaway-loop detector. Third post-hackathon roadmap release. Adds `tx_rate_anomaly` — a cron-triggered detector rule that fires when an agent's mean transaction rate over a 5-minute sliding window exceeds the configured cap (default 30 tx/min, critical at 2× → 60/min). Counts BOTH successful and failed transactions, because a stuck retry loop or a non-stopping LLM burns priority fees regardless of confirmation status. That distinction is the whole point: an existing `error_rate` alert catches the 100%-failed storm; this one catches the 50/50 success/fail storm that drains the wallet just as fast but flies under the error-rate threshold.

### Added
- `tx_rate_anomaly` detector rule (TDD-strict, 11 tests). Cron-only — runs on the same 60s cycle alongside `drawdown` / `error_rate` / `stale_agent` / `ghost_execution` / `low_balance`. Severity `warning` when `ratePerMin > threshold`, escalating to `critical` at `2× threshold` (same slope as `error_rate` — both signal a systemic loss-of-control, not a single bad event). 5-minute window is short enough to surface a retry burst but long enough that a healthy agent doing 20 quick swaps in a row doesn't trip.
- Shared format-alert mappings for `tx_rate_anomaly` — title ("Runaway Loop Suspected"), summary, detail rows (rate, threshold, tx count, window), impact, and action lines. Dashboard + Telegram render identical copy.
- Settings → Notifications → "Runaway loop" row joins the existing rules with per-agent threshold override (`txRateMaxPerMinThreshold`, default 30 tx/min). Per-rule pause from 0.3.0 works for the new rule out of the box.

### Schema
- Migration `0013_tx_rate_anomaly.sql` — `ALTER TYPE alert_rule_name ADD VALUE IF NOT EXISTS 'tx_rate_anomaly'`. Backwards-compatible; existing rows untouched.
- `AlertRuleThresholds.txRateMaxPerMinThreshold` (optional, positive). `DefaultThresholds.txRateMaxPerMin` defaults to 30 across `apps/ingestion/src/index.ts` + the trigger/seed scripts (env override `AGENTSCOPE_TX_RATE_MAX_PER_MIN_THRESHOLD`).

### Notes
Dedupe is 5-minute-bucket keyed — intentionally tighter than drawdown's 1h key. If the loop persists past one window, the next bucket fires again so the user gets re-paged; they want to know the loop is still running, not be silenced after the first alert. Zero-traffic agents abstain (that case belongs to `stale_agent`), keeping the semantic split clean. Full repo gate: lint 275 files clean, typecheck 18/18 packages, test 18/18 turbo tasks (~370+ tests including 11 new runaway).

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

[Unreleased]: https://github.com/PavloDereniuk/AgentScope/compare/v0.4.10...HEAD
[0.4.10]: https://github.com/PavloDereniuk/AgentScope/compare/v0.4.1...v0.4.10
[0.4.1]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.4.1
[0.4.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.4.0
[0.3.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.3.0
[0.2.0]: https://github.com/PavloDereniuk/AgentScope/releases/tag/v0.2.0
