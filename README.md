# AgentScope

> **Datadog for Solana AI agents.**
> Full-stack observability platform for on-chain AI agents — registry, transaction tracing, OpenTelemetry reasoning logs, rule-based anomaly detection, real-time dashboard, Telegram alerts.

**Repository:** [github.com/PavloDereniuk/AgentScope](https://github.com/PavloDereniuk/AgentScope)
**Status:** Live on Railway + Vercel. Epic 10 (submission artifacts) in progress.
**Deadline:** 2026-05-11 — [Colosseum Frontier AI track](https://arena.colosseum.org/frontier)

## Live

| Service | URL |
|---|---|
| Landing | [agentscopehq.dev](https://agentscopehq.dev) |
| Dashboard | [app.agentscopehq.dev](https://app.agentscopehq.dev) |
| API | [api.agentscopehq.dev](https://api.agentscopehq.dev/health) |
| Ingestion | Railway worker (mainnet WebSocket + 60s cron) |

Network: Solana **mainnet**. DB: Supabase Postgres (prod). Auth: Privy.

---

## Why

- 9000+ AI agents already deployed on Solana (Alchemy, 2026)
- 77% of Solana x402 transactions originate from agents
- $45M lost in an AI Trading Agent breach due to lack of monitoring
- ElizaOS has 17,600+ GitHub stars — mass adoption with no monitoring layer

Existing AI observability tools (Braintrust, Langfuse, Arize) monitor LLM calls but not on-chain transactions. Solana explorers see transactions but not agent context or reasoning chains. AgentScope fills the gap.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AgentScope Platform                          │
│                                                                     │
│  apps/landing        apps/dashboard        apps/api                 │
│  ─────────────       ──────────────        ────────                 │
│  Astro 4 static      React 18 SPA          Hono 4.6                 │
│  Marketing page      Privy auth            REST + OTLP + SSE        │
│  Vercel deploy       Vercel deploy         Railway deploy           │
│                                                 │                   │
│                                            apps/ingestion           │
│                                            ───────────────          │
│                                            Yellowstone WS           │
│                                            Parser → Detector        │
│                                            Railway deploy           │
│                                                 │                   │
│                                       packages/db (Supabase Postgres)│
└─────────────────────────────────────────────────────────────────────┘

Agent SDKs:
  @agentscopehq/elizaos-plugin   — ElizaOS auto-instrumentation
  @agentscopehq/agent-kit-sdk    — Solana Agent Kit integration
```

**Data flow:** Solana tx → WebSocket (Helius) → ingestion → parser → DB → detector → alerter → Telegram
**Reasoning flow:** Agent OTel SDK → `POST /v1/traces` → OTLP receiver → DB → dashboard reasoning tree

---

## Features

| Feature | Status |
|---|---|
| Agent registry (register Solana wallets) | ✅ |
| On-chain tx ingestion via Yellowstone WebSocket | ✅ |
| Jupiter v6 swap parsing (slippage, route, amounts) | ✅ |
| Kamino Lend action parsing (deposit/withdraw/borrow) | ✅ |
| OpenTelemetry OTLP/HTTP reasoning receiver | ✅ |
| Tx ↔ reasoning span correlation | ✅ |
| 5 anomaly detection rules (slippage/gas/drawdown/error-rate/stale) | ✅ |
| Per-agent alert threshold overrides | ✅ |
| Telegram alerts | ✅ |
| Real-time SSE push (tx.new / alert.new) | ✅ |
| Dashboard: agent list, detail, PnL chart, tx timeline, reasoning tree | ✅ |
| Dashboard: alerts feed, settings page | ✅ |
| ElizaOS plugin (wrapAction / wrapActions) | ✅ |
| Agent Kit SDK (initAgentScope / traced) | ✅ |
| Demo scripts (trader / yield / NFT agents) | ✅ |
| Discord / Slack alerts | post-MVP |
| Yellowstone gRPC (LaserStream) | post-MVP |
| Mainnet runtime | post-MVP |

---

## Monorepo Structure

```
apps/
  api/          — Hono REST API + OTLP receiver + SSE bus (port 3000)
  ingestion/    — Yellowstone WS ingestion worker + cron detector
  dashboard/    — React 18 SPA (Vite 5, port 5173)
  landing/      — Astro 4 marketing site (static)

packages/
  db/           — Drizzle ORM schema + migrations + PGlite test helpers
  shared/       — Zod schemas + TypeScript types (shared across all)
  parser/       — Jupiter v6 + Kamino Lend instruction parsers
  detector/     — 5 anomaly detection rules + evaluator engine
  alerter/      — Telegram delivery + Discord/Slack stubs
  elizaos-plugin/  — ElizaOS OTel plugin (wrapAction/wrapActions)
  agent-kit-sdk/   — Agent Kit OTel SDK (initAgentScope/traced)
  config/       — Shared TypeScript + Biome configs

scripts/        — CLI demo scripts (tsx, workspace package)
apps/api/railway.json          — Railway API service (Nixpacks / Railpack)
apps/ingestion/railway.json    — Railway ingestion worker
apps/dashboard/vercel.json     — Vercel SPA config (rewrites, caching)
docs/DEPLOY.md                 — full deploy runbook + env matrix
```

---

## REST API (`apps/api`)

Base URL: `http://localhost:3000` (dev) / `https://api.agentscopehq.dev` (prod)

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check — returns `{ ok: true }` |

### OTLP Receiver (agent-token auth via Resource attribute)

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/traces` | OpenTelemetry OTLP/HTTP JSON receiver |

Auth: the OTel `Resource` must carry `agent.token = <ingest_token>` attribute (not an HTTP header). The receiver validates the token against `agents.ingest_token` in the database.

Request: `ExportTraceServiceRequest` JSON (OTLP spec). Response: `{ partialSuccess: {} }` 200.

### Authenticated API (Privy JWT in `Authorization: Bearer`)

All `/api/*` routes require a valid Privy access token. The token is verified by `AuthVerifier` and the resolved `userId` is scoped to every query — cross-tenant access is impossible by construction.

#### Agents

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agents` | Register a new agent (wallet, name, metadata) |
| `GET` | `/api/agents` | List all agents for the authenticated user |
| `GET` | `/api/agents/:id` | Agent detail (24h tx count, last alert, status) |
| `PATCH` | `/api/agents/:id` | Update agent metadata / alert thresholds |
| `DELETE` | `/api/agents/:id` | Delete agent and cascade all child records |

#### Transactions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents/:id/transactions` | Keyset-paginated tx list (`cursor`, `from`, `to`, max 100) |
| `GET` | `/api/transactions/:signature` | Single tx with full reasoning log tree |

#### Reasoning

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents/:id/reasoning` | Reasoning logs for agent (`traceId?` filter) |

#### Alerts

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/alerts` | Global alert feed (`agentId?`, `severity?`, `from?`, `to?`, max 100) |

#### SSE (Server-Sent Events)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents/:id/stream` | Live event stream — emits `tx.new` and `alert.new` events |

Keep-alive ping every 30s. Aborts cleanly on client disconnect.

#### Internal (cross-service, no auth)

| Method | Path | Description |
|---|---|---|
| `POST` | `/internal/publish` | Ingestion worker posts `{ type, agentId, ... }` events to SSE bus |

---

## Ingestion Service (`apps/ingestion`)

Connects to Helius WebSocket (`onLogs`) and subscribes per registered agent wallet. On each confirmed transaction:

1. **Hydrate** — `getTransaction` to fetch full tx data
2. **Parse** — `apps/ingestion/src/pipeline.ts` calls `@agentscope/parser`
3. **Persist** — insert into `agent_transactions` (idempotent — `onConflictDoNothing` on signature)
4. **Detect** — `runTxDetector` evaluates tx-triggered rules (slippage, gas)
5. **Publish** — HTTP `POST /internal/publish` with `tx.new` event → SSE bus → dashboard

**Cron** (60s interval): evaluates cron-triggered rules (drawdown, error_rate, stale_agent) across all agents.

**Wallet registry reconciliation**: new agents registered via API are picked up on the next ingestion cycle without restart.

---

## Parser (`packages/parser`)

Parses raw Solana transaction data into structured `ParsedInstruction` records.

### Jupiter v6

Supported instructions: `route`, `routeWithTokenLedger`, `sharedAccountsRoute`, `exactOutRoute`, `sharedAccountsExactOutRoute`

Parsed fields:
- `slippageBps` — slippage tolerance in basis points
- `fromMint` / `toMint` — input/output token mints
- `inAmount` / `outAmount` — raw lamport/token amounts
- `routePlan` — swap route hops
- SOL delta from pre/post token balance walk

Detection logic: 3-strategy mint resolution (route plan, transfer accounts, native SOL wrap detection).

### Kamino Lend

Supported instructions: `depositReserveLiquidity`, `withdrawObligationCollateral`, `borrowObligationLiquidity`, `repayObligationLiquidity`, `liquidateObligationAndRedeemReserveCollateral`, and compound wrappers.

Discriminators computed via sha256 of `"global:<instructionName>"` (Anchor IDL format).

Parsed fields: `amount`, `reserve`, `obligation`, `liquidity_amount`, market action type.

---

## Anomaly Detector (`packages/detector`)

Two evaluation modes:

- **Tx-triggered** — fires immediately after each persisted transaction
- **Cron-triggered** — runs every 60 seconds across all active agents

### Rules

| Rule | Type | Default Threshold | Severity escalation |
|---|---|---|---|
| `slippage_spike` | Tx | 1% slippage | warning → critical at 5× threshold |
| `gas_spike` | Tx | 3× 24h median fee | warning → critical at 5× threshold (15×) |
| `error_rate` | Cron | 20% failed txs in 1h | warning → critical at 2× threshold (40%) |
| `drawdown` | Cron | 10% P&L loss in 1h | warning → critical at 3× threshold (30%) |
| `stale_agent` | Cron | 30 min inactivity | info → warning at 3× threshold (90 min) |

All thresholds support **per-agent overrides** via `agents.alertRules` JSONB column (configurable from the Settings page). Falls back to global `DefaultThresholds` from env if not set.

Deduplicated via `dedupeKey` — same anomaly will not re-fire within the cooldown window (time-bucket based).

---

## Alerter (`packages/alerter`)

### Telegram (implemented)

Sends HTML-formatted messages to a configured chat ID via the Telegram Bot API.

Format: severity badge + rule name + agent ID + payload summary.

Config: `TELEGRAM_BOT_TOKEN` env var (bot-level). Per-agent `chat_id` rides on each `AlertMessage` via `agents.telegram_chat_id` — no deployer-wide fallback (Epic 14 multi-tenant safety).

### Discord / Slack (stubbed, post-MVP)

Delivery router is in place — adding a new channel requires implementing one `deliver()` strategy.

---

## Dashboard (`apps/dashboard`)

React 18 SPA, Vite 5, Tailwind, shadcn/ui, Recharts, Privy auth.

### Pages

| Route | Description |
|---|---|
| `/agents` | Agent list with status badges (live / stale / failed), search, create new agent |
| `/agents/:id` | Agent detail: 4 stat cards (tx count, P&L, error rate, last seen), PnL chart (Recharts AreaChart), tx timeline, reasoning span tree (click tx to correlate), SSE live updates |
| `/alerts` | Global alerts feed with severity filter tabs (all / critical / warning / info) |
| `/settings` | Per-agent webhook URL + 5 alert threshold inputs (slippage / gas / error rate / drawdown / stale) |

### Components

| Component | Description |
|---|---|
| `PnlChart` | Recharts `AreaChart` — cumulative SOL delta time series with gradient fill |
| `TxTimeline` | Chronological transaction list — instruction icon, SOL delta coloring, success/fail indicators |
| `ReasoningTree` | Recursive span tree built from flat parent-child list — expand/collapse by depth |
| `ErrorBoundary` | React class ErrorBoundary with reload button |
| `ProtectedRoute` | Redirects to Privy login if not authenticated |

### State management

- `@tanstack/react-query` for all server state (staleTime 30s, retry 1)
- `useStream` hook — EventSource wrapper that invalidates queries on `tx.new` / `alert.new` SSE events

---

## ElizaOS Plugin (`packages/elizaos-plugin`)

Auto-instruments ElizaOS actions with OpenTelemetry spans and ships them to AgentScope.

**Install from npm:**

```bash
pnpm add @agentscopehq/elizaos-plugin@alpha
# or: npm install @agentscopehq/elizaos-plugin@alpha
```

```typescript
import { initAgentScope, wrapActions } from '@agentscopehq/elizaos-plugin';

const sdk = initAgentScope({
  apiUrl: 'https://api.agentscopehq.dev',
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
});

// Wrap all ElizaOS actions — each becomes a traced span
const instrumentedActions = wrapActions(actions, runtime);
```

**`wrapAction(action)`** — wraps a single ElizaOS `Action` handler. Creates a span for every action execution with attributes:
- `action.name` — action identifier
- `reasoning.input` — message content text
- `reasoning.agent_id` — ElizaOS runtime agent ID
- `solana.tx.signature` — correlated Solana tx (from `options.txSignature` if provided)
- Span status: OK on success, ERROR with recorded exception on failure

**`wrapActions(actions)`** — convenience wrapper for an array of actions.

**Agent identity**: set via OTel `Resource` attribute `agent.token` — no HTTP headers needed. The OTLP exporter sends this to `POST /v1/traces`.

No dependency on `@elizaos/core` at build time — uses duck-typed internal interfaces.

---

## Agent Kit SDK (`packages/agent-kit-sdk`)

Lightweight OTel integration for Solana Agent Kit workflows.

**Install from npm:**

```bash
pnpm add @agentscopehq/agent-kit-sdk@alpha
# or: npm install @agentscopehq/agent-kit-sdk@alpha
```

```typescript
import { initAgentScope, traced } from '@agentscopehq/agent-kit-sdk';

const sdk = initAgentScope({
  apiUrl: 'https://api.agentscopehq.dev',
  agentToken: process.env.AGENTSCOPE_AGENT_TOKEN,
});

// Wrap any async operation — creates a traced span automatically
const price = await traced('fetch_price', async () => {
  return await jupiter.getPrice('SOL/USDC');
});

// With custom attributes
const tx = await traced('execute_swap', async () => {
  return await kit.swap('SOL', 'USDC', 1.0);
}, {
  'swap.from': 'SOL',
  'swap.to': 'USDC',
  'swap.amount_usd': 150,
  'solana.tx.signature': tx.signature,
});

await sdk.shutdown(); // flush remaining spans before process exit
```

**`initAgentScope(config)`** — creates and starts a global `NodeSDK` singleton. Returns the SDK for shutdown control.

**`traced(name, fn, attrs?)`** — wraps an async function in an OTel span. Propagates parent context (nested spans work). Records errors automatically. Returns the original value.

Context propagation: nested `traced()` calls automatically create parent-child span relationships.

---

## Demo Scripts (`scripts/`)

All scripts use `@agentscopehq/agent-kit-sdk` and require env vars: `AGENTSCOPE_API_URL`, `AGENTSCOPE_AGENT_TOKEN_*`, `SOLANA_RPC_URL`.

| Script | Command | Description |
|---|---|---|
| `demo-trader.ts` | `pnpm --filter @agentscope/scripts demo-trader` | Simulates a token-trading agent: market analysis + swap execution spans |
| `demo-yield.ts` | `pnpm --filter @agentscope/scripts demo-yield` | Simulates a yield strategy agent: rate scan + Kamino deposit spans |
| `demo-nft.ts` | `pnpm --filter @agentscope/scripts demo-nft` | Simulates an NFT arbitrage agent: floor price check + listing spans |
| `trigger-anomaly.ts` | `pnpm --filter @agentscope/scripts trigger-anomaly` | Forces slippage spike (50% BPS) + deliberate error span — exercises alert rules |
| `setup-wallets.ts` | `pnpm --filter @agentscope/scripts setup-wallets` | Generates devnet keypairs + requests SOL airdrop + registers agents via API |

---

## Landing Page (`apps/landing`)

Astro 4 static site with Tailwind CSS. Sections:

- **Hero** — headline, subheadline, "Start Monitoring" CTA → dashboard, "GitHub" link
- **Features** — 6 feature cards (agent registry, tx tracing, OTel reasoning, anomaly detection, alerts, SDK)
- **DemoVideo** — embedded demo walkthrough
- **CTA** — final call-to-action with dashboard link

Deployed to Vercel as a separate project. `PUBLIC_DASHBOARD_URL` env var controls the dashboard link.

---

## Database Schema (`packages/db`)

Supabase Postgres (free tier). All tables have Row-Level Security.

| Table | Description |
|---|---|
| `users` | Privy DID → internal UUID mapping |
| `agents` | Solana wallet → agent metadata + alert rule overrides + ingest token |
| `agent_transactions` | Parsed tx records (RANGE-partitioned by `block_time`, monthly) |
| `reasoning_logs` | OTel spans with flattened attributes + optional `tx_signature` correlation |
| `alerts` | Fired alert records with severity, payload, dedupe key, delivered_at |

RLS policy: `current_user_id()` session variable set per-transaction by the API. Ingestion worker uses BYPASSRLS service role.

Partitioning: `agent_transactions` partitioned by `block_time` RANGE, monthly. Composite PK `(id, block_time)` required by Postgres for range partitions.

---

## Environment Variables

See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for the full matrix per service. Minimal local `.env`:

```bash
# Database (Supabase Postgres Transaction Pooler)
DATABASE_URL=postgresql://postgres.xxx:PASSWORD@aws-…:6543/postgres

# Solana (Helius free tier — mainnet)
HELIUS_API_KEY=...
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_NETWORK=mainnet

# Auth (Privy — matching dashboard origin in Allowed Origins)
PRIVY_APP_ID=...
PRIVY_APP_SECRET=...
VITE_PRIVY_APP_ID=...                # exposed at build time for the SPA

# Internal cross-service secret (≥32 chars, shared by api + ingestion)
INTERNAL_SECRET=...

# Alerting (per-agent chat_id stored in DB — no deployer fallback)
TELEGRAM_BOT_TOKEN=...

# Frontend wiring
VITE_API_BASE_URL=http://localhost:3000
VITE_LANDING_URL=http://localhost:4321
```

⚠️ `TELEGRAM_DEFAULT_CHAT_ID` is deprecated since Epic 14 Phase 1 — do **not** set it in production. Per-agent `chat_id` now travels on each `AlertMessage`; setting the env var in prod would re-route every new tenant's alerts into the deployer's personal chat.

---

## Development

```bash
# Prerequisites: Node 24+, pnpm 9+
git clone https://github.com/PavloDereniuk/AgentScope.git
cd agentscope
pnpm install
cp .env.example .env   # fill in vars above

# Run everything in parallel (turbo)
pnpm dev

# Individual services
pnpm --filter @agentscope/api dev          # port 3000
pnpm --filter @agentscope/ingestion dev    # ingestion worker
pnpm --filter @agentscope/dashboard dev    # port 5173
pnpm --filter @agentscope/landing dev      # port 4321

# Database
pnpm --filter @agentscope/db db:generate   # generate migrations
pnpm --filter @agentscope/db db:push       # push to Supabase
```

---

## Deployment

See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for the full deploy runbook (env var matrix, Railway + Vercel setup, Supabase RLS check).

**Infrastructure today:**

| Layer | Where | Why |
|---|---|---|
| API + Ingestion | Railway Hobby | Long-running Node processes, internal DNS between services |
| Dashboard + Landing | Vercel Hobby | Edge CDN, zero-config Vite/Astro, free tier |
| Postgres | Supabase Free | 500MB + RLS built-in, managed backups |
| Alerts | Telegram Bot API | Zero infra, per-agent `chat_id` (Epic 14 multi-tenant) |

API + ingestion share the same `DATABASE_URL` (Supabase Transaction Pooler, port 6543); ingestion also calls API via public URL for `POST /internal/publish` SSE events.

---

## Testing

```bash
pnpm test          # full suite via turbo (parallel, ~100–120s fresh)
pnpm typecheck     # TypeScript strict check (16 packages)
pnpm lint          # Biome lint + format check
pnpm lint:fix      # auto-fix
pnpm build         # production build (all packages)
```

**224 tests, all green:**

| Package | Tests | Coverage area |
|---|---|---|
| `@agentscope/shared` | 27 | Zod schemas + type alignment |
| `@agentscope/db` | 7 | PGlite migrations, CRUD, cascade, unique constraints |
| `@agentscope/parser` | 22 | 9 dispatcher + 6 Jupiter + 7 Kamino (real mainnet fixtures) |
| `@agentscope/detector` | 33 | 7 evaluator + 5 rule suites (slippage/gas/error-rate/drawdown/stale) |
| `@agentscope/alerter` | 6 | Telegram format + delivery router |
| `@agentscope/ingestion` | 3 | Detector runner + cron cycle |
| `@agentscopehq/elizaos-plugin` | 3 | Mock OTLP server: success span, error status, tx correlation |
| `@agentscopehq/agent-kit-sdk` | 4 | Mock OTLP server: resource attr, custom attrs, error, parent-child |
| `@agentscope/api` | 119 | 6 error middleware + 6 auth + 7 SSE bus + 6 cursor + 44 agents CRUD + 8 transactions + 11 alerts + 24 OTLP + 7 reasoning |

---

## Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm 9 + Turborepo 2.3 |
| Language | TypeScript 5.6 strict |
| Lint/Format | Biome 1.9 |
| Test | Vitest 2.1 |
| Backend | Hono 4.6 |
| ORM | Drizzle 0.36 |
| Database | Supabase Postgres (free) + PGlite (tests) |
| Blockchain | @solana/web3.js + Yellowstone WebSocket (Helius) |
| Telemetry | OpenTelemetry OTLP/HTTP |
| Auth | Privy |
| Frontend | React 18 + Vite 5 + Tailwind + shadcn/ui + Recharts |
| Landing | Astro 4.16 |
| Hosting | Railway (api/ingestion) + Vercel (dashboard/landing) |
| Alerts | Telegram Bot API |

---

## Development Process

AgentScope was built solo for the [Colosseum Frontier AI track](https://arena.colosseum.org/frontier) using an agentic engineering workflow.

The codebase was developed with **[Claude Code](https://claude.ai/code)** — Anthropic's AI coding agent — with every architectural decision, security pattern, and implementation detail continuously reviewed and validated by the author.

---

## License

MIT
