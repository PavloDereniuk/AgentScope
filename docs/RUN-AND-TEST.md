# AgentScope — How to Run & Test

## Prerequisites

- **Node.js** >= 24
- **pnpm** >= 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **`.env`** file in the project root (see [Environment Variables](#environment-variables))

## Install

```bash
pnpm install
```

## Environment Variables

Copy `.env.example` (if exists) or create `.env` in the project root:

```env
# --- Database (Supabase Postgres) ---
DATABASE_URL=postgresql://postgres.<project>:<password>@aws-0-eu-west-3.pooler.supabase.com:6543/postgres

# --- Privy Auth ---
PRIVY_APP_ID=<your-privy-app-id>
PRIVY_APP_SECRET=<your-privy-app-secret>
VITE_PRIVY_APP_ID=<same-as-PRIVY_APP_ID>

# --- Helius / Solana ---
HELIUS_API_KEY=<your-helius-api-key>
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your-helius-api-key>

# --- Telegram Alerts (optional for dev) ---
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_DEFAULT_CHAT_ID=<your-chat-id>
```

## Run in Development

### All services at once (turbo)

```bash
pnpm dev
```

This starts all apps in parallel via Turborepo:
- **API** → `http://localhost:3000` (Hono + tsx watch)
- **Dashboard** → `http://localhost:5173` (Vite dev server)
- **Ingestion** → WebSocket stream worker (tsx watch)

### Individual services

```bash
# API only
pnpm --filter @agentscope/api dev

# Dashboard only
pnpm --filter @agentscope/dashboard dev

# Ingestion worker only
pnpm --filter @agentscope/ingestion dev
```

### Verify API is running

```bash
curl http://localhost:3000/health
# → {"ok":true}
```

### Dashboard proxy

Vite dev server proxies `/api/*` and `/v1/*` to `http://localhost:3000`, so
the dashboard and API work together without CORS issues. Make sure the API
is running before opening the dashboard.

## Tests

### Run all tests

```bash
pnpm test
```

Runs Vitest across all packages via Turborepo. Uses PGlite (in-process PG16
WASM) — no external database needed for tests.

**~217 tests, ~85-100s fresh, ~5s cached.**

### Run tests for a specific package

```bash
pnpm --filter @agentscope/api test        # 119 tests (API routes, auth, OTLP)
pnpm --filter @agentscope/parser test      # 22 tests (Jupiter + Kamino parsers)
pnpm --filter @agentscope/detector test    # 33 tests (5 rules + evaluator)
pnpm --filter @agentscope/alerter test     # 6 tests (Telegram formatting + delivery)
pnpm --filter @agentscope/ingestion test   # 3 tests (detector runner + cron)
pnpm --filter @agentscope/shared test      # 27 tests (zod schemas + types)
pnpm --filter @agentscope/db test          # 7 tests (migrations + CRUD)
```

### Watch mode

```bash
pnpm test:watch
# or for a specific package:
pnpm --filter @agentscope/api test:watch
```

## Linting & Type Checking

```bash
# Lint all (Biome)
pnpm lint

# Auto-fix lint issues
pnpm lint:fix

# Type check all packages (tsc --noEmit via turbo)
pnpm typecheck
```

**All three must be green before committing.**

## Build

```bash
pnpm build
```

Runs `tsc` build across all packages via Turborepo.

## Database

### Migrations (Drizzle)

```bash
# Generate migration from schema changes
pnpm --filter @agentscope/db db:generate

# Run pending migrations
pnpm --filter @agentscope/db db:migrate

# Push schema directly (dev only, no migration file)
pnpm --filter @agentscope/db db:push
```

### Helper scripts

```bash
# Verify Supabase state (tables, partitions, RLS)
pnpm --filter @agentscope/db tsx scripts/verify-supabase.ts

# Seed a test agent (needs AGENT_WALLET env)
AGENT_WALLET=<solana-pubkey> pnpm --filter @agentscope/db tsx scripts/seed-test-agent.ts

# Count persisted transactions
pnpm --filter @agentscope/db tsx scripts/count-tx.ts

# Reset test data
pnpm --filter @agentscope/db tsx scripts/reset-test-data.ts
```

## Project Structure

```
apps/
  api/          → Hono REST API + OTLP receiver (port 3000)
  dashboard/    → React SPA with Privy auth (port 5173)
  ingestion/    → WebSocket stream worker + detector + cron
  landing/      → Astro landing page (not started yet)

packages/
  db/           → Drizzle schema + migrations + PGlite test helpers
  shared/       → Zod schemas + branded types (used by API + dashboard)
  parser/       → Jupiter v6 + Kamino Lend transaction parsers
  detector/     → Rule engine (slippage, gas, error-rate, drawdown, stale)
  alerter/      → Telegram message formatting + delivery
  elizaos-plugin/  → ElizaOS auto-instrumentation (placeholder, Epic 7)
  agent-kit-sdk/   → Solana Agent Kit helpers (placeholder, Epic 7)
  config/       → Shared tsconfig base

docs/
  SPEC.md       → Product specification
  PLAN.md       → Technical architecture
  TASKS.md      → Atomic task checklist (77/99 done)
  SCRATCHPAD.md → Session recovery notes
```

## Quick Smoke Test Sequence

```bash
# 1. Install
pnpm install

# 2. All tests pass?
pnpm test

# 3. Types OK?
pnpm typecheck

# 4. Lint OK?
pnpm lint

# 5. Start API
pnpm --filter @agentscope/api dev &

# 6. Health check
curl http://localhost:3000/health

# 7. Start dashboard
pnpm --filter @agentscope/dashboard dev &

# 8. Open browser
# → http://localhost:5173 → Privy login → Agents page
```
