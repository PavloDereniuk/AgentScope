# AgentScope — Продуктова специфікація

> **Datadog для Solana AI агентів.** Платформа моніторингу та observability для on-chain AI агентів.

**Статус:** v1 — фіналізовано (всі відкриті питання закриті 2026-04-07)
**Дата:** 2026-04-07
**Дедлайн сабмішну:** 2026-05-11 (Colosseum Frontier, AI track)
**Команда:** Solo dev, vibe-coding (~95%)

---

## 1. Мета

Одне речення: **AgentScope — SaaS-платформа, яка дає розробникам та операторам Solana AI агентів повну видимість у дії агента on-chain (транзакції, gas, P&L) разом з reasoning chain, що привів до цих дій, і алертить коли поведінка виходить за межі норми.**

---

## 2. Проблема

- **9000+ AI агентів** вже задеплоєно на Solana (Alchemy, 2026)
- **77% x402 транзакцій** на Solana — від агентів
- **$45M втрачено** у breach AI Trading Agent через відсутність моніторингу
- **ElizaOS** — 17,600+ GitHub stars, масова adoption, жодного monitoring-шару

**Чому існуючі рішення не підходять:**

| Інструмент | Недолік |
|---|---|
| Braintrust / Langfuse / Arize | Тільки LLM calls, не бачать on-chain транзакції |
| Solana Explorer / Solscan / Helius Explorer | Бачать tx, але без контексту агента і reasoning |
| Datadog / New Relic | Не Solana-aware, немає парсингу Jupiter/Kamino тощо |

**Аналогія:** Kubernetes без Prometheus/Grafana. Агенти є — спостерігати за ними нічим.

---

## 3. Користувачі

### Primary persona: **Solo-розробник AI агента на ElizaOS/Agent Kit**
- Задеплоїв 1-5 агентів, керує через Discord/Telegram
- Потребує: «агент живий?», «що він робить зараз?», «чому зробив саме цей свап?», «чи не зламаний?»

### Secondary persona: **Операційний інженер невеликого agent-фонду**
- 10-50 агентів, різні стратегії (trading / yield / NFT)
- Потребує: dashboard з метриками P&L per-agent, алерти про drawdown, історія рішень для post-mortem

### Сценарії використання (MVP)
1. **Registration.** Користувач логіниться (Privy), реєструє агента за wallet pubkey + metadata (назва, framework, теги).
2. **Auto-instrumentation.** Встановлює ElizaOS plugin або Agent Kit helper — reasoning logs автоматично летять в AgentScope через OTel.
3. **Live observability.** Відкриває dashboard — бачить список агентів зі статусами (live/stale/failed), timeline транзакцій per-agent у real-time.
4. **Drill-down.** Клікає на транзакцію — бачить parsed instruction (Jupiter swap: USDC→SOL, 5% slippage), correлований reasoning chain, gas spent, result.
5. **Alert.** Агент робить аномальний свап (slippage 50%). Користувач отримує Telegram повідомлення за <30 сек.
6. **Post-mortem.** Відкриває per-agent view, сортує за error rate, знаходить root cause у reasoning logs.

---

## 4. Функціональні вимоги (MVP)

### 4.1 Agent Registry
- **FR-1.** Реєстрація агента: wallet pubkey, name, framework (`elizaos` / `agent-kit` / `custom`), type (`trader` / `yield` / `nft` / `other`), tags, webhook URL.
- **FR-2.** CRUD ендпоінти: `POST/GET/PATCH/DELETE /agents`.
- **FR-3.** Multi-tenancy: кожен агент належить user-id (з Privy auth).

### 4.2 On-chain Ingestion
- **FR-4.** Підписка на Yellowstone gRPC stream (безкоштовний Helius tier).
- **FR-5.** Фільтрація транзакцій за wallet pubkeys зареєстрованих агентів.
- **FR-6.** Парсинг інструкцій: **Jupiter v6** (swaps) та **Kamino Lend** (deposit/withdraw/borrow/repay).
- **FR-7.** Запис у `agent_transactions`: `signature`, `slot`, `timestamp`, `agent_id`, `program_id`, `instruction_name`, `parsed_args` (jsonb), `sol_delta`, `token_deltas` (jsonb), `fee`, `success`, `logs`.
- **FR-8.** Devnet-first (Фаза тестування), потім міграція на mainnet (Фаза 5 роадмапу).

### 4.3 Reasoning Collector (OpenTelemetry)
- **FR-9.** OTel-сумісний HTTP endpoint (OTLP/HTTP) для прийому traces/spans з агентів.
- **FR-10.** Span attributes: `agent.id`, `reasoning.prompt`, `reasoning.model`, `reasoning.output`, `reasoning.decision`, `solana.tx.signature` (для кореляції).
- **FR-11.** Кореляція: якщо span має `solana.tx.signature` — лінкується з відповідним `agent_transactions` рядком.
- **FR-12.** Зберігання повного chain-of-thought у `reasoning_logs` (jsonb tree).

### 4.4 Anomaly Detector (rule-based)
- **FR-13.** Правила MVP:
  - `slippage_spike`: Jupiter swap зі slippage > N% (configurable per agent, default 5%)
  - `gas_spike`: tx fee > N × rolling 24h median
  - `drawdown`: P&L за 1h нижче порогу (configurable)
  - `error_rate`: failed tx ratio > N% за 1h
  - `stale_agent`: відсутність активності > N хвилин (для «always-on» агентів)
- **FR-14.** Evaluator запускається після кожного ingested tx та періодично (cron 1 хв) для time-based правил.
- **FR-15.** Trigger → запис у `alerts` → delivery через Telegram webhook (Фаза 1), потім Discord + Slack (Фаза 2).

### 4.5 Dashboard (React)
- **FR-16.** Auth через Privy (email + embedded wallet).
- **FR-17.** Views:
  - `/agents` — список з real-time статусами, search, filters
  - `/agents/:id` — per-agent view: stats cards (tx count, success rate, SOL spent, last seen), timeline транзакцій + reasoning, P&L chart (Recharts), alerts history
  - `/alerts` — global alerts feed
  - `/settings` — webhook URLs, alert rule thresholds
- **FR-18.** Real-time updates через Server-Sent Events (SSE).
- **FR-19.** Responsive: працює на desktop, базово на tablet.

### 4.6 SDK & Integrations
- **FR-20.** `@agentscope/elizaos-plugin` — автоматична інструментація ElizaOS агента (OTel exporter + action hooks).
- **FR-21.** `@agentscope/agent-kit-sdk` — helper wrapper для Solana Agent Kit (decorators для tracing).
- **FR-22.** Quickstart guide: інтеграція за ≤5 хвилин.

---

## 5. Нефункціональні вимоги

| Категорія | Вимога |
|---|---|
| **Latency (tx → dashboard)** | ≤ 2 сек від confirmation до появи в UI (p95) |
| **Alert delivery** | ≤ 30 сек від trigger до Telegram повідомлення (p95) |
| **Throughput** | 50 tx/sec sustained per worker (достатньо для демо + ~50 агентів) |
| **Availability demo** | ≥ 99% під час live пітчу (single-region OK) |
| **Data retention** | 30 днів у MVP (free tier Supabase) |
| **Security** | Всі secrets через env vars, RLS у Supabase per user_id, валідація input через Zod |
| **Scalability** | Horizontal: ingestion worker stateless, API stateless. Vertical scale Postgres до 1GB (free tier) |
| **Observability self** | Structured logs (pino) + basic health endpoint |

---

## 6. Стек (прийняті рішення з інтерв'ю)

| Шар | Вибір | Причина |
|---|---|---|
| Language | TypeScript (strict) | Один стек backend/frontend/SDK |
| Monorepo | pnpm workspaces + Turborepo | Стандарт для TS monorepo |
| Backend framework | Hono | Легкий, швидкий, працює де завгодно |
| DB | Supabase Postgres (free) | Auth, RLS, real-time, безкоштовно |
| ORM | Drizzle | TS-first, легкий, без magic |
| RPC provider | Helius free tier | Безкоштовний Yellowstone доступ |
| Frontend | React 18 + Vite + Tailwind + shadcn/ui + Recharts | Швидкий dev, стандарт |
| Auth | Privy | Web3-friendly, простий для solo dev |
| Telemetry | OpenTelemetry OTLP/HTTP | Стандарт індустрії |
| Alerting | Telegram Bot API (Phase 1) | Найшвидша інтеграція |
| Hosting backend/worker | Railway free tier | Безкоштовний, простий деплой з GitHub |
| Hosting landing page | Vercel free tier | Окремий деплой від apps monorepo, edge CDN |
| Domain | `*.railway.app` / `*.vercel.app` (no custom domain) | Бюджет = $0 |
| Plugin distribution | GitHub install (`pnpm add github:...`) | No npm org needed for MVP; npm publish post-hackathon |
| Tests | Vitest | TS-нативний |
| Linter/Format | Biome | Швидший за ESLint+Prettier, єдиний tool |

---

## 7. Поза скоупом (explicit)

Наступне **НЕ** буде у хакатонському MVP:

- ❌ Біллінг, тарифи, ліміти (Free/Pro/Enterprise — тільки у pitch deck)
- ❌ Mainnet на старті (тільки devnet, міграція на mainnet у Фазі 5)
- ❌ Discord та Slack alerting (тільки Telegram у MVP; Discord/Slack у post-MVP)
- ❌ ML-based anomaly detection (тільки rule-based)
- ❌ Парсинг протоколів поза Jupiter v6 + Kamino Lend (MarginFi / Tensor / Marinade — post-MVP)
- ❌ SSO, enterprise SLA, dedicated support
- ❌ Decentralized / on-chain reputation layer
- ❌ API для страхових протоколів (risk scoring endpoint)
- ❌ Mobile app
- ❌ Custom alert rule builder (UI) — тільки env-configurable thresholds у MVP
- ❌ Backfill історичних транзакцій (тільки forward streaming)
- ❌ Team/organization management (тільки single-user)
- ❌ Audit log, RBAC

---

## 8. Критерії приймання MVP

Проект вважається готовим до сабмішну коли:

1. **✅ Інтеграція за 5 хвилин.** Новий користувач може: встановити ElizaOS plugin → задеплоїти агента на devnet → побачити транзакцію у дашборді ≤ 5 хв від старту.
2. **✅ 3 робочі тестові агенти.** На devnet живуть та роблять дії: (a) trader (Jupiter swaps), (b) yield (Kamino deposits), (c) NFT buyer (custom — mock, якщо Tensor не встигнемо).
3. **✅ Real-time tx → dashboard.** Свап з'являється у UI за ≤ 2 сек від confirmation.
4. **✅ Reasoning correlation works.** Клік на tx → видно reasoning chain, що привів до цієї дії.
5. **✅ Аномалія тригерить алерт.** Симуляція 50% slippage → Telegram повідомлення ≤ 30 сек.
6. **✅ Всі 5 rule-based правил працюють** (slippage, gas, drawdown, error_rate, stale_agent).
7. **✅ Quickstart guide** на GitHub/Mintlify: копі-пасте → працює.
8. **✅ Demo video 3-4 хв** знятий, залитий на YouTube, лінк у README.
9. **✅ Landing page** з CTA «Join Waitlist».
10. **✅ Pitch deck** 10 слайдів.
11. **✅ Submission на Colosseum** до 2026-05-11.
12. **✅ CI/CD** — PR → lint + test + build.
13. **✅ README** з quickstart < 5 хв.
14. **✅ Тести** покривають парсери (Jupiter/Kamino), detector rules, API auth.

---

## 9. Припущення та відкриті питання

### Припущення
- Helius free tier витримає навантаження демо (rate limit: ~10 req/sec)
- Supabase free (500 MB Postgres) вистачить для 30 днів retention + ~50 тестових агентів
- Privy free tier підтримує embedded wallet логін без біллінгу
- ElizaOS API стабільний (version pin у package.json)
- Railway/Fly.io free tier достатньо для ingestion worker + API (1 vCPU, 512 MB)

### Закриті рішення (resolved 2026-04-07)
- **R1.** ElizaOS plugin → **GitHub install** (`pnpm add github:user/agentscope#main/packages/elizaos-plugin`). Без npm org. npm publish відкладено до post-hackathon.
- **R2.** Domain → **немає**. Працюємо на `*.railway.app` (backend/api) + `*.vercel.app` (landing). Бюджет = $0.
- **R3.** Telegram bot token → **створює користувач** через `@BotFather`, токен передає у `.env` (`TELEGRAM_BOT_TOKEN`).
- **R4.** Demo агенти → **реальні devnet swap'и** з devnet SOL + devnet USDC (з faucet). Без моків.
- **R5.** Landing page → **окремий деплой на Vercel**, окремий апп у monorepo (`apps/landing`), власний `vercel.json`. Backend/dashboard/worker — на Railway.

---

## 10. Ризики та мітігації (MVP-scope)

| Ризик | Ймовірність | Вплив | Мітігація |
|---|---|---|---|
| Helius free rate limit блокує ingestion | Med | High | Кеш транзакцій, backoff, план міграції на Triton free на випадок |
| Supabase 500 MB заповнюється | Low | Med | Партиціонування, TTL cleanup job (30 днів), моніторинг |
| OTel інструментація ElizaOS зламається при оновленні | Med | Med | Pin versions, інтеграційні тести у CI |
| Парсинг Jupiter IDL ламається при upgrade | Low | High | Anchor IDL, snapshot IDL у repo, unit tests |
| Live demo падає під час пітчу | Med | Critical | Pre-recorded fallback video, статичний snapshot state у БД |
| Solo vibe-coding veers off-scope | High | High | Строге дотримання TASKS.md, відмова від «nice-to-have» після Тижня 3 |
| 34 дні — замало | Med | High | Кожного тижня reassessment, aggressive cut якщо MVP під загрозою |

---

## 11. Посилання на джерела

- Ідея та ринковий контекст: `../agentscope-project.md`
- Воркфлоу розробки: `../Workspace/docs/PROJECT-BOOTSTRAP.md` (стандарт)
- Alchemy 2026 Solana AI Report
- ElizaOS GitHub: 17,600+ stars
- Solana Agent Registry (mainnet 2026)

---

**Наступний крок:** затвердження цього `SPEC.md`. Після «OK / затверджено» → переходжу до Фази 2: `docs/PLAN.md` + ініціалізація проекту.
