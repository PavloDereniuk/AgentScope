# AgentScope

> **Datadog for Solana AI agents.**
> Observability platform for on-chain AI agents on Solana — registry, transaction tracing, OpenTelemetry reasoning logs, anomaly detection, real-time alerts.

**Status:** in development (Colosseum Frontier 2026 submission, deadline 2026-05-11)

## Why

- 9000+ AI agents already deployed on Solana (Alchemy, 2026)
- 77% of Solana x402 transactions originate from agents
- $45M lost in an AI Trading Agent breach due to lack of monitoring
- ElizaOS has 17,600+ GitHub stars — mass adoption with no monitoring layer

Existing AI observability tools (Braintrust, Langfuse, Arize) monitor LLM calls but not on-chain transactions. Solana explorers see transactions but not agent context or reasoning chains. AgentScope fills the gap.

## Features (MVP)

- **Agent Registry** — register Solana wallets as agents with metadata
- **On-chain ingestion** via Yellowstone gRPC, parsing Jupiter v6 swaps and Kamino Lend
- **Reasoning collector** — OpenTelemetry OTLP/HTTP receiver with tx correlation
- **Rule-based anomaly detection** — slippage spikes, gas spikes, drawdown, error rate, stale agents
- **Real-time dashboard** with Server-Sent Events
- **Telegram alerts** (Discord/Slack post-MVP)
- **SDKs** for ElizaOS (auto-instrumentation) and Solana Agent Kit

## Stack

TypeScript / pnpm + Turborepo / Hono / Drizzle ORM / Supabase Postgres / Yellowstone gRPC (Helius) / React + Vite + Tailwind + shadcn/ui / Privy / OpenTelemetry / Astro (landing)

## Quickstart

```bash
# Prerequisites: Node 24+, pnpm 9+
git clone <repo>
cd agentscope
pnpm install
cp .env.example .env  # fill in DATABASE_URL, HELIUS_API_KEY, PRIVY_APP_ID, TELEGRAM_BOT_TOKEN
pnpm dev
```

See `docs/SPEC.md` for product spec, `docs/PLAN.md` for architecture.

## License

TBD
