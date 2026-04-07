# AgentScope — Технічний план

> **Зв'язок:** реалізує `docs/SPEC.md` v1. Будь-яка зміна архітектури → спочатку оновити цей файл, потім обговорити.

**Дата:** 2026-04-07
**Дедлайн:** 2026-05-11

---

## 1. Стек технологій (фіксовані версії)

### Runtime / Tooling
| Компонент | Версія | Обґрунтування |
|---|---|---|
| Node.js | 24.x LTS | Локально доступний (24.11.0) |
| pnpm | 9.x | Через `corepack` (вбудований у Node) |
| Turborepo | ^2.3 | Стандарт для TS monorepo, кеш build/test |
| TypeScript | ^5.6 | strict mode, без `any` |
| Biome | ^1.9 | Lint + format в одному tool, у 30× швидший за ESLint+Prettier |
| Vitest | ^2.1 | TS-нативний, швидкий, ESM-first |

### Backend (`apps/api`, `apps/ingestion`)
| Пакет | Версія | Призначення |
|---|---|---|
| `hono` | ^4.6 | HTTP-фреймворк (API) |
| `@hono/node-server` | ^1.13 | Node adapter |
| `@hono/zod-validator` | ^0.4 | Валідація payload |
| `drizzle-orm` | ^0.36 | ORM, TS-first |
| `drizzle-kit` | ^0.28 | Міграції |
| `postgres` | ^3.4 | PG driver (sql template literals) |
| `@triton-one/yellowstone-grpc` | ^1.3 | Yellowstone gRPC client (Helius-compatible) |
| `@solana/web3.js` | ^1.95 | Solana primitives |
| `@coral-xyz/anchor` | ^0.30 | Anchor IDL parsing (Jupiter, Kamino) |
| `zod` | ^3.23 | Schema валідація на boundary |
| `pino` | ^9.5 | Structured logging |
| `pino-pretty` | ^11.3 | Dev-friendly logs |
| `@opentelemetry/api` | ^1.9 | OTel collector core |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.55 | OTLP receiver helper |

### Frontend (`apps/dashboard`)
| Пакет | Версія | Призначення |
|---|---|---|
| `react` / `react-dom` | ^18.3 | UI |
| `vite` | ^5.4 | Build tool |
| `@vitejs/plugin-react` | ^4.3 | React HMR |
| `react-router-dom` | ^6.28 | Routing |
| `@privy-io/react-auth` | ^2.0 | Auth |
| `@tanstack/react-query` | ^5.59 | Server state |
| `tailwindcss` | ^3.4 | Styling |
| `shadcn/ui` | latest | Компонентна бібліотека (через CLI) |
| `lucide-react` | ^0.460 | Іконки |
| `recharts` | ^2.13 | Графіки |
| `dayjs` | ^1.11 | Дати |

### Landing (`apps/landing`)
| Пакет | Версія | Призначення |
|---|---|---|
| `astro` | ^4.16 | Static site, edge-friendly, мінімум JS |
| `@astrojs/tailwind` | ^5.1 | Tailwind інтеграція |

### SDK packages
| Пакет | Призначення |
|---|---|
| `@elizaos/core` (peer dep) | ElizaOS plugin API |
| `solana-agent-kit` (peer dep) | Agent Kit hooks |
| `@opentelemetry/sdk-node` | OTel exporter (на стороні агента) |

### Принципи вибору залежностей
- **Мінімум.** Жодних dev-deps "на всякий випадок"
- **Без alpha-версій.** Тільки stable
- **Жодних залежностей з ESM/CJS war.** Все ESM
- **Кожна нова deps після Тижня 1 — потребує обґрунтування у комміті**

---

## 2. Архітектура

### Високорівнева діаграма

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AGENT SIDE (user-deployed)                    │
│  ┌────────────────┐    ┌────────────────────────────────────────┐  │
│  │ ElizaOS plugin │    │ Solana Agent Kit + @agentscope SDK     │  │
│  │ (auto-instr.)  │    │ (manual instrumentation via decorators)│  │
│  └───────┬────────┘    └───────────────┬────────────────────────┘  │
│          │ OTLP/HTTP                    │ OTLP/HTTP                  │
│          │ traces+spans                 │ traces+spans               │
└──────────┼────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENTSCOPE BACKEND                            │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              apps/api (Hono, port 3000) — Railway              │ │
│  │  POST /v1/traces ───┐  REST CRUD ─────┐  SSE /agents/:id/stream│ │
│  │  GET  /api/agents   │  /api/* (auth)  │                        │ │
│  │  GET  /api/alerts   │                 │                        │ │
│  └──────────┬──────────┴──────────┬──────┴────────────────────────┘ │
│             │                     │                                  │
│             ▼                     ▼                                  │
│  ┌──────────────────────────────────────────┐                      │
│  │  packages/db (Drizzle) — Supabase Postgres│                      │
│  │  agents | tx | reasoning_logs | alerts   │                      │
│  └──────────┬───────────────────────────────┘                      │
│             ▲                                                         │
│             │ writes                                                  │
│  ┌──────────┴──────────────────────────────────────────────────────┐│
│  │       apps/ingestion (Yellowstone gRPC worker) — Railway         ││
│  │  - Subscribe to TX stream (mainnet/devnet)                       ││
│  │  - Filter by registered agent wallets                            ││
│  │  - Parse via packages/parser (Jupiter v6, Kamino Lend)           ││
│  │  - Run packages/detector after each insert                       ││
│  │  - Trigger alerts → packages/alerter (Telegram first)            ││
│  └────────────────────┬─────────────────────────────────────────────┘│
│                       │ subscribes                                    │
└───────────────────────┼─────────────────────────────────────────────┘
                        ▼
                ┌──────────────────┐
                │  Helius free     │
                │  Yellowstone gRPC│
                │  (devnet→mainnet)│
                └──────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Vercel)                              │
│  ┌─────────────────────────┐    ┌──────────────────────────────┐   │
│  │ apps/dashboard (Vite SPA)│    │ apps/landing (Astro static)  │   │
│  │ - Privy auth             │    │ - Hero, features, demo video │   │
│  │ - Agent list, drill-down │    │ - "Join waitlist" CTA        │   │
│  │ - SSE live tx stream     │    │                              │   │
│  └────────────┬─────────────┘    └──────────────────────────────┘   │
│               │ fetch + EventSource                                  │
└───────────────┼───────────────────────────────────────────────────┘
                ▼
       (Hono API on Railway)
```

### Деплой-топологія

| Сервіс | Платформа | Тип | URL |
|---|---|---|---|
| API (Hono) | Railway | Web service | `agentscope-api.up.railway.app` |
| Ingestion worker | Railway | Background worker | (no public URL) |
| Postgres | Supabase | Free tier | (internal connection string) |
| Dashboard (Vite SPA) | Vercel | Static + serverless | `agentscope-dashboard.vercel.app` |
| Landing (Astro) | Vercel | Static | `agentscope.vercel.app` |
| Cron (alert eval) | Railway cron | Scheduled (`*/1 * * * *`) | (internal) |

### Чому Hono (а не Fastify / Express)
- Cloudflare Workers / Bun / Node — однаковий код (runtime portable)
- Менший footprint, швидший cold-start
- Native zod validation через `@hono/zod-validator`
- SSE з коробки

### Чому Astro для landing (а не Next.js)
- 0 JS by default → миттєва відповідь судді на пітчі
- Окремий деплой від dashboard → не змішуємо trade-offs SPA та статичної сторінки
- Менше залежностей

---

## 3. Модель даних

### Схема Postgres (Drizzle)

```typescript
// packages/db/src/schema.ts (псевдокод)

users {
  id            uuid PK (від Privy DID)
  privy_did     text UNIQUE NOT NULL
  email         text
  created_at    timestamptz DEFAULT now()
}

agents {
  id                uuid PK
  user_id           uuid FK → users.id
  wallet_pubkey     text NOT NULL  -- Solana base58 pubkey
  name              text NOT NULL
  framework         enum('elizaos', 'agent-kit', 'custom') NOT NULL
  agent_type        enum('trader', 'yield', 'nft', 'other') NOT NULL
  tags              text[]
  webhook_url       text  -- nullable, для алертів
  alert_rules       jsonb -- override default thresholds
  created_at        timestamptz DEFAULT now()
  last_seen_at      timestamptz
  status            enum('live', 'stale', 'failed') DEFAULT 'stale'

  UNIQUE (user_id, wallet_pubkey)
  INDEX idx_agents_user (user_id)
  INDEX idx_agents_wallet (wallet_pubkey)
}

agent_transactions {
  id                bigserial PK
  agent_id          uuid FK → agents.id
  signature         text NOT NULL
  slot              bigint NOT NULL
  block_time        timestamptz NOT NULL
  program_id        text NOT NULL
  instruction_name  text  -- "jupiter.swap", "kamino.deposit", etc
  parsed_args       jsonb -- normalized args from parser
  sol_delta         numeric(20,9)  -- net SOL change
  token_deltas      jsonb -- [{mint, decimals, delta}]
  fee_lamports      bigint
  success           boolean NOT NULL
  raw_logs          text[]

  INDEX idx_tx_agent_time (agent_id, block_time DESC)
  INDEX idx_tx_signature (signature)
  PARTITION BY RANGE (block_time)  -- monthly
}

reasoning_logs {
  id                uuid PK
  agent_id          uuid FK → agents.id
  trace_id          text NOT NULL  -- OTel trace_id (16 bytes hex)
  span_id           text NOT NULL  -- OTel span_id (8 bytes hex)
  parent_span_id    text
  span_name         text NOT NULL  -- "decision", "llm_call", "tool_call"
  start_time        timestamptz NOT NULL
  end_time          timestamptz NOT NULL
  attributes        jsonb -- includes prompt, model, output, decision, etc.
  tx_signature      text -- nullable; for correlation with agent_transactions

  INDEX idx_reason_agent_time (agent_id, start_time DESC)
  INDEX idx_reason_trace (trace_id)
  INDEX idx_reason_tx (tx_signature) WHERE tx_signature IS NOT NULL
}

alerts {
  id                uuid PK
  agent_id          uuid FK → agents.id
  rule_name         text NOT NULL  -- "slippage_spike", "gas_spike", etc.
  severity          enum('info', 'warning', 'critical') NOT NULL
  payload           jsonb -- rule-specific context (threshold, actual, tx ref)
  triggered_at      timestamptz DEFAULT now()
  delivered_at      timestamptz
  delivery_channel  enum('telegram', 'discord', 'slack')
  delivery_status   enum('pending', 'delivered', 'failed')
  delivery_error    text

  INDEX idx_alerts_agent_time (agent_id, triggered_at DESC)
}
```

### Default alert thresholds (env-configurable)

```bash
AGENTSCOPE_SLIPPAGE_PCT_THRESHOLD=5      # FR-13 slippage_spike
AGENTSCOPE_GAS_MULT_THRESHOLD=3           # tx fee > 3× rolling 24h median
AGENTSCOPE_DRAWDOWN_PCT_THRESHOLD=10      # 1h drawdown
AGENTSCOPE_ERROR_RATE_PCT_THRESHOLD=20    # 1h failed tx ratio
AGENTSCOPE_STALE_MINUTES_THRESHOLD=30     # no activity
```

### Row-Level Security (Supabase)

```sql
-- Кожен користувач бачить тільки свої агенти і їхні дані
CREATE POLICY "users_own_agents" ON agents
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "users_own_tx" ON agent_transactions
  FOR SELECT USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );
-- (аналогічно для reasoning_logs та alerts)
```

---

## 4. API контракти

### Auth flow
- Frontend: Privy embedded login → отримує JWT
- Кожен запит до `/api/*`: header `Authorization: Bearer <privy_jwt>`
- Hono middleware: `@privy-io/server-auth` валідує JWT, інжектить `c.var.userId`

### REST endpoints

```
# Agent Registry
POST   /api/agents
  body:  { wallet_pubkey, name, framework, agent_type, tags?, webhook_url?, alert_rules? }
  resp:  201 { agent }

GET    /api/agents
  resp:  200 { agents: Agent[] }

GET    /api/agents/:id
  resp:  200 { agent, recent_tx_count, last_alert }

PATCH  /api/agents/:id
  body:  Partial<{ name, tags, webhook_url, alert_rules }>
  resp:  200 { agent }

DELETE /api/agents/:id
  resp:  204

# Transactions
GET    /api/agents/:id/transactions
  query: ?cursor&limit=50&from&to
  resp:  200 { transactions: AgentTx[], next_cursor }

GET    /api/transactions/:signature
  resp:  200 { transaction, reasoning_logs }

# Reasoning logs
GET    /api/agents/:id/reasoning
  query: ?cursor&limit=50&trace_id?
  resp:  200 { logs: ReasoningLog[], next_cursor }

# Alerts
GET    /api/alerts
  query: ?agent_id?&severity?&from&to
  resp:  200 { alerts: Alert[] }

# Real-time stream
GET    /api/agents/:id/stream
  resp:  text/event-stream
         events: "tx" | "reasoning" | "alert" | "ping" (every 15s)

# Health
GET    /health
  resp:  200 { ok: true, db: 'up', ingestion: 'up' }

# OTLP/HTTP receiver (no auth, agent_id у span attribute)
POST   /v1/traces
  body:  OTLP protobuf or JSON (per OTel spec)
  resp:  200 { partialSuccess: {} }
```

### Error format

```json
{ "error": { "code": "INVALID_INPUT", "message": "...", "details": {...} } }
```

Коди: `INVALID_INPUT`, `UNAUTHORIZED`, `NOT_FOUND`, `RATE_LIMITED`, `INTERNAL`.

---

## 5. Структура файлів

```
agentscope/
├── apps/
│   ├── api/                    # Hono REST + SSE + OTLP receiver
│   │   ├── src/
│   │   │   ├── index.ts        # entry, server
│   │   │   ├── routes/
│   │   │   │   ├── agents.ts
│   │   │   │   ├── transactions.ts
│   │   │   │   ├── reasoning.ts
│   │   │   │   ├── alerts.ts
│   │   │   │   ├── stream.ts   # SSE
│   │   │   │   ├── health.ts
│   │   │   │   └── otlp.ts     # POST /v1/traces
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts     # Privy JWT
│   │   │   │   └── error.ts
│   │   │   └── lib/
│   │   │       └── sse-bus.ts  # in-memory pub/sub for SSE
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ingestion/              # Yellowstone gRPC worker
│   │   ├── src/
│   │   │   ├── index.ts        # entry
│   │   │   ├── grpc-client.ts  # Yellowstone subscription
│   │   │   ├── filter.ts       # filter by registered wallets
│   │   │   ├── persist.ts      # write to DB
│   │   │   ├── detector-runner.ts  # invoke packages/detector
│   │   │   └── cron.ts         # periodic stale-agent + drawdown checks
│   │   └── package.json
│   ├── dashboard/              # React SPA (Vite)
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── App.tsx
│   │   │   ├── routes/
│   │   │   │   ├── agents.tsx
│   │   │   │   ├── agent-detail.tsx
│   │   │   │   ├── alerts.tsx
│   │   │   │   └── settings.tsx
│   │   │   ├── components/
│   │   │   │   ├── ui/         # shadcn
│   │   │   │   ├── tx-timeline.tsx
│   │   │   │   ├── reasoning-tree.tsx
│   │   │   │   ├── pnl-chart.tsx
│   │   │   │   └── status-badge.tsx
│   │   │   ├── lib/
│   │   │   │   ├── api-client.ts
│   │   │   │   ├── sse.ts
│   │   │   │   └── privy.tsx
│   │   │   └── styles.css
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   └── landing/                # Astro static site (separate Vercel deploy)
│       ├── src/
│       │   ├── pages/
│       │   │   └── index.astro
│       │   └── components/
│       │       ├── Hero.astro
│       │       ├── Features.astro
│       │       └── DemoVideo.astro
│       ├── astro.config.mjs
│       └── package.json
│
├── packages/
│   ├── db/                     # Drizzle schemas + migrations + client
│   │   ├── src/
│   │   │   ├── schema.ts
│   │   │   ├── client.ts       # exports `db` singleton
│   │   │   └── migrations/     # drizzle-kit generated
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   ├── parser/                 # Solana tx instruction parsers
│   │   ├── src/
│   │   │   ├── index.ts        # `parseTransaction(tx) → ParsedTx`
│   │   │   ├── jupiter/
│   │   │   │   ├── idl.json    # frozen IDL snapshot
│   │   │   │   └── parser.ts
│   │   │   ├── kamino/
│   │   │   │   ├── idl.json
│   │   │   │   └── parser.ts
│   │   │   └── types.ts
│   │   ├── tests/
│   │   │   ├── jupiter.test.ts # fixtures with real tx data
│   │   │   └── kamino.test.ts
│   │   └── package.json
│   ├── detector/               # rule-based anomaly detection
│   │   ├── src/
│   │   │   ├── index.ts        # `evaluate(ctx) → Alert[]`
│   │   │   ├── rules/
│   │   │   │   ├── slippage.ts
│   │   │   │   ├── gas.ts
│   │   │   │   ├── drawdown.ts
│   │   │   │   ├── error-rate.ts
│   │   │   │   └── stale.ts
│   │   │   └── types.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── alerter/                # delivery (telegram/discord/slack)
│   │   ├── src/
│   │   │   ├── index.ts        # `deliver(alert)` strategy router
│   │   │   ├── telegram.ts
│   │   │   ├── discord.ts      # post-MVP stub
│   │   │   └── slack.ts        # post-MVP stub
│   │   └── package.json
│   ├── elizaos-plugin/         # ElizaOS auto-instrumentation
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── otel-exporter.ts
│   │   │   └── action-hooks.ts
│   │   ├── tests/
│   │   └── package.json
│   ├── agent-kit-sdk/          # Solana Agent Kit helpers
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── trace-decorator.ts
│   │   │   └── otel-setup.ts
│   │   └── package.json
│   ├── shared/                 # types, zod schemas, otel utils
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── schemas.ts      # zod
│   │   │   └── otel.ts
│   │   └── package.json
│   └── config/                 # shared tsconfig, biome
│       ├── tsconfig.base.json
│       └── biome.json
│
├── infra/
│   ├── docker-compose.yml      # local Postgres for dev
│   └── README.md
├── scripts/
│   ├── seed-demo-agents.ts     # creates 3 demo agents on devnet
│   └── trigger-anomaly.ts      # demo: simulate slippage spike
│
├── .github/
│   └── workflows/
│       └── ci.yml              # lint + typecheck + test + build
│
├── .env.example
├── .gitignore
├── .nvmrc
├── biome.json                  # root biome config
├── tsconfig.json               # root tsconfig (references)
├── turbo.json                  # turbo pipeline
├── pnpm-workspace.yaml
├── package.json                # workspace root
├── README.md
├── CLAUDE.md
└── docs/
    ├── SPEC.md
    ├── PLAN.md
    ├── TASKS.md
    └── SCRATCHPAD.md
```

---

## 6. Безпека

### Auth
- **Frontend → API:** Privy JWT, валідація через `@privy-io/server-auth` middleware у Hono
- **OTLP receiver:** агент аутентифікується через `agent_token` у span attribute (генерується при реєстрації, унікальний UUID, зберігається в `agents.ingest_token`). Без token → 401.
- **Ingestion worker → DB:** service role connection string у Railway secrets

### Авторизація
- Supabase **RLS** на всіх таблицях per `user_id` (документовано вище)
- API endpoints додатково перевіряють `agent.user_id === ctx.userId` перед mutation

### Валідація
- **Кожен POST/PATCH** → zod schema через `@hono/zod-validator`
- **OTLP payload** → парсимо через офіційний `@opentelemetry/proto` schema
- **Solana pubkeys** → `PublicKey.isOnCurve()` перед записом

### Секрети
- `.env` у `.gitignore`, `.env.example` чекіниться з placeholder'ами
- Railway / Vercel — env vars через UI, ніколи у код
- `pre-commit` hook (через `husky` або біль-у-біль bash) перевіряє відсутність токенів

### Прийняті ризики (документовано)
- **Без CSRF.** API stateless, JWT, no cookies → не потрібен.
- **Без rate limit на /v1/traces у MVP.** Trade-off: спрощення vs DoS ризик. Мітігація: Cloudflare proxy на Railway (free).
- **Без email verification.** Privy сам валідує email/social.

---

## 7. Залежності — повний список з обґрунтуванням

(дублює п.1, але як інвентар; будь-яка нова deps після ініціалізації — потребує обґрунтування у комміті)

| Категорія | Кількість | Підстава |
|---|---|---|
| Core (TS, Vite, Hono, React) | 8 | Стек проекту |
| Solana / Web3 | 3 | yellowstone-grpc, web3.js, anchor |
| DB (drizzle, postgres) | 2 | ORM + driver |
| Validation (zod) | 1 | shared |
| Logging (pino) | 2 | core + pretty |
| OTel | 3 | api, exporter, sdk-node |
| UI lib (tailwind, shadcn, lucide, recharts, dayjs) | 5 | dashboard |
| Auth (privy server + react) | 2 | shared |
| Astro (landing) | 2 | static site |
| Testing (vitest) | 1 | tests |
| Tooling (biome, turbo) | 2 | DX |
| **Разом** | **~31 prod + dev пакети** | Все обґрунтовано |

---

## 8. Ризики та компроміси

| Ризик | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Helius free rate limit | Med | High | Кеш + backoff; готовий fallback на Triton free |
| Supabase 500 MB переповниться | Low | Med | Партиціонування + TTL cleanup (30 днів) |
| OTel ElizaOS інструментація крихка | Med | Med | Pin versions; інтеграційні тести у CI |
| Jupiter/Kamino IDL змінюється | Low | High | Заморозити IDL у repo, unit тести з фікстурами |
| pnpm на Windows + Drizzle migrations | Low | Med | Тестувати локально; альтернатива — npm |
| Live demo падає на пітчі | Med | Critical | Pre-recorded fallback video |
| Solo + 34 дні vs scope | High | High | Жорстке дотримання TASKS.md; cut nice-to-have після Тижня 3 |
| Privy free tier обмеження | Low | Med | Документовано: до 1k MAU безкоштовно — вистачить |

### Прийняті trade-offs

- **Hono замість Fastify.** Менше middleware ecosystem → пишемо самі. Виграш: portable, SSE з коробки.
- **Astro замість Next.js для landing.** Немає SSR/API routes → ОК, бо landing статичний.
- **Drizzle замість Prisma.** Менше magic, швидші builds, але менш зріле tooling. ОК для MVP.
- **Server-Sent Events замість WebSocket.** Тільки server→client потрібно. SSE простіше, нативно через `Response`.
- **In-memory SSE bus.** Не масштабується через декілька інстансів, але MVP = 1 інстанс. Post-MVP → Redis pub/sub.
- **Single-region hosting.** US-East Railway. Latency для EU/Asia ~150ms — прийнятно.
- **Без backfill історії.** Тільки forward streaming з моменту реєстрації агента.

---

## 9. CI/CD pipeline

`.github/workflows/ci.yml`:

```yaml
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run lint typecheck test build
```

### Деплой
- **Railway:** Git push до `main` → auto-deploy (`apps/api`, `apps/ingestion` як окремі сервіси)
- **Vercel:** Git push → auto-deploy (`apps/dashboard`, `apps/landing` як два проєкти)
- **Drizzle migrations:** `pnpm db:migrate` перед deploy через Railway pre-deploy hook

---

## 10. Стратегія тестування

| Шар | Тип | Інструмент | Покриття |
|---|---|---|---|
| `packages/parser` | Unit з фікстурами реальних tx | Vitest | ≥ 90% |
| `packages/detector` | Unit (in-memory state) | Vitest | ≥ 90% |
| `packages/db` | Schema migration test | Vitest + pg-mem | smoke |
| `apps/api` routes | Integration (test DB) | Vitest + supertest-like | критичні endpoints |
| `apps/dashboard` | Component smoke | Vitest + RTL | критичні views |
| `apps/ingestion` | Manual + smoke на devnet | — | вручну |

**TDD strict для:** parser, detector. Інші — pragmatic (тести після або разом).

---

## 11. Що не входить у Фазу 2 (відкладено до Фази 3 — TASKS.md)

- Точні step-by-step задачі та оцінки
- Послідовність епіків та залежності між задачами
- Атрибуція задач до тижнів роадмапу

Це піде у `docs/TASKS.md` після затвердження цього PLAN.

---

**Наступний крок:** Після затвердження PLAN — ініціалізую monorepo (pnpm + Turborepo), створю всі базові config-файли, ініціалізую git, і напишу `CLAUDE.md` (≤60 рядків).
