# AgentScope — Code Review Fixes History

This file is read at the start of every code review run to avoid re-reporting
already-fixed issues and to provide continuity across sessions.

---

## Session 2026-04-16 — Full-project review (`--path`)

Review file: `output/md/code-review/review_full-project_2026-04-16.md`
Commit: `177ad60` (fix: address all findings from full-project code review)

### Critical fixes

#### 1. `apps/ingestion/src/index.ts` — Detector/alerter never wired into main()
**Problem:** `startCron`, `createEventPublisher`, and `createTelegramSender` were imported but
never called, meaning no anomaly detection or alerting ran in production.
**Fix:** Added full wiring in `main()`: constructed `DetectorDeps`, passed it to `persistTx`,
started the cron scheduler, and registered `cron.stop()` in the shutdown handler.
**Why:** Without this the entire alerting subsystem was dead code.

#### 2. `packages/alerter/src/telegram.ts` — Infinite retry loop on HTTP 429
**Problem:** On Telegram rate-limit (429), `attempt++` was missing before `continue`, so the
loop counter never advanced and the sender would spin forever.
**Fix:** Added `attempt++` before `continue` inside the 429 branch.
**Why:** Infinite loop would hang the ingestion process until OOM or manual kill.

#### 3. `apps/api/src/routes/agents.ts` — `ingestToken` leaked in list endpoint
**Problem:** `db.select().from(agents)` returned all columns including `ingestToken` (a secret
credential) in the paginated agent list response.
**Fix:** Replaced wildcard select with explicit column projection that excludes `ingestToken`.
**Why:** Exposing ingest tokens to the frontend allows any authenticated user to impersonate
agents (send fake traces/transactions).

#### 4. `apps/dashboard/src/lib/use-stream.ts` — JWT sent as URL query param
**Problem:** `EventSource` cannot set custom headers, so the Privy JWT was appended to the
SSE URL as `?token=...`, exposing it in browser history, server access logs, and HTTP Referer.
**Fix:** Replaced `EventSource` with `fetch` + `ReadableStream.getReader()`, sends JWT as
`Authorization: Bearer` header.
**Why:** Tokens in URLs are a well-known credential-leakage vector (OWASP).

#### 5. `packages/db/src/client.ts` — `sql` variable shadowed drizzle's `sql` tag
**Problem:** `const sql = postgres(...)` shadowed the `sql` template-tag import from
`drizzle-orm`, silently breaking any raw SQL expression that used the tag.
**Fix:** Renamed the postgres client variable to `pgClient`.
Also removed `Object.assign(db, { $client: pgClient })` — drizzle-orm v0.36 already
exposes `db.$client` natively, so the override created a doubled type.
**Why:** Silent shadowing causes hard-to-diagnose runtime bugs; type doubling breaks
downstream code that reads `$client`.

#### 6. `apps/ingestion/src/ws-stream.ts` — Failed transactions silently dropped
**Problem:** `if (logs.err) return;` skipped persisting failed transactions, so the
`error_rate` detector rule had no data to fire on.
**Fix:** Removed the early-return guard so failed txs are persisted (with their error info).
**Why:** The error-rate rule is meaningless if errors are never stored.

#### 7. `apps/ingestion/src/detector-runner.ts` — Alert correlation broken
**Problem:** Alert rows were correlated with results by array index (brittle: relies on
Postgres RETURNING preserving insertion order, which is not guaranteed) and the
`dedupeKey` column was missing from the RETURNING clause.
**Fix:** Added `dedupeKey` to RETURNING, built a `Map<dedupeKey, row>` for O(1) lookup.
**Why:** Wrong correlation caused alerts to be sent with the wrong `triggeredAt` timestamp
or silently skipped.

---

### Warning fixes

#### 8. `apps/api/src/otlp/schema.ts` — Unbounded span arrays
**Problem:** `resourceSpans` and `spans` arrays had no size limits, allowing a single
OTLP request to insert unlimited rows.
**Fix:** Added `.max(1000)` on spans and `.max(100)` on resourceSpans.
**Why:** Prevents a single misbehaving agent from exhausting DB write capacity.

#### 9. `apps/api/src/otlp/persist.ts` — Malformed timestamps crash entire batch
**Problem:** A single span with an invalid `startTimeUnixNano` or `endTimeUnixNano`
threw an error that aborted the entire batch insert.
**Fix:** Wrapped the `nanoToTimestamp` calls in try/catch with `continue` to skip
only the bad span.
**Why:** One corrupted span should not discard valid spans from the same export.

#### 10. `apps/api/src/otlp/persist.ts` — No validation on `solana.tx.signature`
**Problem:** The `solana.tx.signature` attribute was stored directly without format
validation, allowing arbitrary strings to corrupt tx-correlation queries.
**Fix:** Added `SOLANA_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/` and applied it
before storing. Min is 32 (not 64) to accommodate test fixtures with leading zero bytes.
**Why:** Agent-controlled attribute — must be validated at the persistence boundary.

#### 11. `packages/detector/src/rules/slippage.ts` — Edge-case guards
**Problem 1:** Negative `slippageBps` (parser anomaly) would pass the threshold check
trivially (negative < threshold is always false).
**Problem 2:** A zero `thresholdPct` (misconfigured agent) would make `actualPct >=
0 * 5 = 0` true for every swap, generating constant critical alerts.
**Fix:** Added `if (args.slippageBps < 0) return null;` and `if (thresholdPct <= 0) return null;`.
**Why:** Prevents alert storms from parser bugs or misconfiguration.

#### 12. `apps/dashboard/src/routes/agent-detail.tsx` — NaN in `totalSolSpent`
**Problem:** `Number(tx.solDelta)` can return `NaN` for null/undefined values, which
propagates through `reduce` and renders as `NaN SOL`.
**Fix:** Added `Number.isFinite(delta)` guard before adding to accumulator.
**Why:** UI shows "NaN SOL" for agents with missing balance data.

#### 13. `apps/dashboard/src/components/reasoning-tree.tsx` — Circular span references
**Problem:** The tree builder had no guard against a span being its own parent or
against cycles in general, which would cause infinite recursion.
**Fix:** Added `childSet` set to track already-placed spans, added `MAX_TREE_DEPTH = 50`
constant, added depth guard in `SpanNode` component.
**Why:** Malformed OTel traces could crash the dashboard with a stack overflow.

#### 14. `apps/ingestion/src/ws-stream.ts` — Invalid wallet pubkey not caught
**Problem:** `new PublicKey(walletPubkey)` throws for malformed keys but was not
wrapped in try/catch, crashing the entire subscription loop.
**Fix:** Added try/catch in `subscribeWallet` and a per-wallet try/catch in
`reconcileWallets`.
**Why:** One bad wallet in the DB should not kill monitoring for all other wallets.

---

### Lint fixes (Biome)

#### 15. `apps/dashboard/src/lib/use-stream.ts:35`
`headers['Authorization']` → `headers.Authorization` (Biome `useLiteralKeys` rule).

#### 16. `packages/alerter/src/telegram.ts:68`
`` `https://api.telegram.org/bot` `` → `'https://api.telegram.org/bot'`
(Biome `noUnusedTemplateLiteral` rule).

---

## How to use this file in future reviews

When running `/code-review`, the reviewer agent reads this file first.
For each finding, check whether it matches an already-fixed item by:
1. File path + symptom
2. Rule/pattern name

If a finding is substantively the same as an entry here, mark it as **[already fixed in
YYYY-MM-DD session]** and skip it unless there is evidence of a regression.

New fixes should be appended at the bottom of the relevant session block, or in a new
dated session block.
