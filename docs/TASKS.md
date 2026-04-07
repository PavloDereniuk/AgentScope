# AgentScope — Атомарні задачі

> **Звʼязок:** реалізує `docs/PLAN.md`. Кожна задача = один комміт = одна область коду = ≤10 хв ревʼю.
>
> **Дедлайн:** 2026-05-11 (34 дні від 2026-04-07).
>
> **Легенда:**
> `[ ]` — pending · `[~]` — in progress · `[x]` — done · `[!]` — blocked
> `→ N.M` — залежить від задачі N.M
> `‖` — можна паралельно з попередньою
> `⏱ Nm` — оцінка хвилин (±50%, vibe-coding)
> `✅ <критерій>` — критерій завершення

---

## Структура за тижнями

| Тиждень | Дати | Фокус | Епіки |
|---|---|---|---|
| 1 | 04-07 → 04-13 | Foundation | E1 |
| 2 | 04-14 → 04-20 | Backend Core (Parsers + API) | E2, E3 |
| 3 | 04-21 → 04-27 | Reasoning + Detector + Alerter | E4, E5 |
| 4 | 04-28 → 05-04 | Dashboard | E6 |
| 5a | 05-05 → 05-08 | SDKs + Demo agents | E7, E8 |
| 5b | 05-09 → 05-11 | Polish + Submission | E9 |

---

## Епік 1 — Foundation (Week 1)

**Мета:** працююча БД, схема, ingestion прототип, акаунти у всіх безкоштовних сервісах.

### Інфраструктура та акаунти (паралельно з кодингом, юзер сам)
- [ ] **1.0a** Створити Supabase project (free tier), скопіювати DATABASE_URL у `.env` ⏱ 10m
  ✅ `.env` має валідний DATABASE_URL, `psql $DATABASE_URL -c '\dt'` працює
- [ ] **1.0b** ‖ Створити Helius account (free), отримати API key + Yellowstone gRPC URL+token у `.env` ⏱ 10m
  ✅ `.env` має HELIUS_API_KEY, YELLOWSTONE_GRPC_URL, YELLOWSTONE_GRPC_TOKEN
- [ ] **1.0c** ‖ Створити Privy app (free), скопіювати App ID + Secret у `.env` ⏱ 10m
  ✅ `.env` має PRIVY_APP_ID, PRIVY_APP_SECRET
- [ ] **1.0d** ‖ Створити Telegram bot через `@BotFather`, скопіювати token у `.env` ⏱ 5m
  ✅ `.env` має TELEGRAM_BOT_TOKEN, тестове повідомлення працює через curl
- [ ] **1.0e** ‖ Створити GitHub repo `agentscope`, push initial commit ⏱ 5m
  ✅ Repo створено, push пройшов, CI на GitHub запустився

### Пакет: shared types
- [x] **1.1** `packages/shared/src/types.ts` — базові TS типи (`Agent`, `AgentTransaction`, `ReasoningLog`, `Alert`, `AlertRule`) ⏱ 30m
  ✅ Експортується з `@agentscope/shared`, `pnpm typecheck` зелений
- [x] **1.2** `packages/shared/src/schemas.ts` — Zod schemas для всіх вище типів ⏱ 45m → 1.1
  ✅ Schemas і типи з 1.1 синхронізовані через `z.infer`, тести з валідними/невалідними прикладами

### Пакет: db (Drizzle + Supabase)
- [x] **1.3** `packages/db`: drizzle-orm + drizzle-kit + postgres deps, `drizzle.config.ts`, базовий `client.ts` ⏱ 30m
  ✅ `pnpm --filter @agentscope/db typecheck` зелений
- [x] **1.4** `packages/db/src/schema.ts` — таблиці `users`, `agents`, `agent_transactions` (партиціонована), `reasoning_logs`, `alerts`, ENUM-и ⏱ 90m → 1.3
  ✅ `pnpm --filter @agentscope/db db:generate` створює міграцію без помилок
- [x] **1.5** Перша міграція + RLS policies (raw SQL у `migrations/0001_rls_and_partition.sql`) ⏱ 60m → 1.4
  ✅ Drizzle generate idempotent. ⏳ Runtime `db:push` на Supabase — чекає DATABASE_URL з USER-SETUP §1
- [x] **1.6** `packages/db/src/index.ts` — експорт + RLS helpers (`setRequestUserId`, `withRequestUser`) ⏱ 15m → 1.5
  ✅ `import { createDb, agents, withRequestUser } from '@agentscope/db'` працює з інших пакетів
- [x] **1.7** Smoke-тест на PGlite (real PG16 in WASM, not pg-mem): insert агента → select → assert + cascade + unique ⏱ 30m → 1.6
  ✅ `pnpm --filter @agentscope/db test` зелений (7/7)

### Apps: ingestion POC
- [x] **1.8** `apps/ingestion`: tsx + pino + dotenv setup, `src/index.ts` з health log ⏱ 20m → 1.6
  ✅ `pnpm --filter @agentscope/ingestion dev` стартує і логує "ingestion worker started"
- [x] **1.9** `apps/ingestion/src/grpc-client.ts` — підключення до Yellowstone gRPC, subscribe на slot updates ⏱ 60m → 1.8, 1.0b
  ⚠️ Helius LaserStream (gRPC) — Pro план only. Код лишається у repo для post-MVP. **Заміна на 1.9b (WebSocket).**
- [x] **1.9b** `apps/ingestion/src/ws-stream.ts` — WebSocket fallback через `@solana/web3.js` `onLogs` + `onSlotChange` ⏱ 45m
  ✅ Працює на Helius free tier
- [x] **1.10** Subscribe на transactions для devnet — лог signature + program_ids ⏱ 45m → 1.9
  ✅ Лог `tx <sig> programs=[...]` тече у консоль (через ws-stream)
- [x] **1.11** Insert raw tx у `agent_transactions` (client-side filter by wallet→agent map). 2.12 додасть server-side `accountInclude` фільтр у Yellowstone request для bandwidth saving. ⏱ 45m → 1.10, 1.6
  ✅ Code complete (db client + WalletRegistry + persistTx). Runtime `count(*)` росте — чекає DATABASE_URL + Helius creds

### CI sanity
- [x] **1.12** Зробити `pnpm lint && pnpm typecheck && pnpm test && pnpm build` зеленим у CI ⏱ 30m → all above
  ✅ Локально все 4 кроки green (58 lint files, 13 packages typecheck, 13 test, 11 build). GitHub Actions verifies after USER-SETUP §5 (repo push)

**Гейт Тиждень 1:** ✅ ingestion worker пише raw tx у Supabase з devnet. Без парсингу, без API.

**Стан Тижня 1:** код 12/12 готовий, 4-step CI green локально. Runtime валідація (Supabase + Helius) чекає USER-SETUP.

---

## Епік 2 — Solana Parsers (Week 2 part 1)

**Мета:** надійні TDD-парсери Jupiter v6 та Kamino Lend з фікстурами реальних tx.

### Parser foundation
- [x] **2.1** `packages/parser`: deps (`@coral-xyz/anchor`, `@solana/web3.js`), типи `ParsedInstruction` / `ParsedTx` / `ParseInput` / `ProgramParser` у `src/types.ts` ⏱ 30m
  ✅ Типи експортуються, typecheck зелений
- [x] **2.2** `packages/parser/src/dispatcher.ts` + `index.ts` — реальна дispatcher з sol/token delta computation, registry, fallbacks ⏱ 20m → 2.1
  ✅ 9/9 тестів зелені (empty registry, token deltas, registered parser, failed tx)

### Fixtures (реальні tx з devnet)
- [x] **2.3** `packages/parser/tests/fixtures/`: 5 реальних Jupiter v6 swap tx (mainnet, бо devnet pools без liquidity) ⏱ 60m → Helius creds
  ✅ 5 файлів `jupiter-swap-N.json` (12-20KB кожен) з base64-encoded response від `getTransaction`, v0 + ALT lookups
- [ ] **2.4** ‖ 5 реальних Kamino Lend tx: deposit, withdraw, borrow, repay, liquidate (devnet) ⏱ 60m → 1.0b
  ✅ 5 файлів `kamino-N.json`

### Jupiter v6 parser (TDD)
- [ ] **2.5** `tests/jupiter.test.ts` — failing тести для всіх 5 fixtures (assert: `instruction_name='jupiter.swap'`, `parsed_args.{input_mint,output_mint,in_amount,out_amount,slippage_bps}`) ⏱ 60m → 2.3
  ✅ 5 тестів падають з очікуваними assertions
- [ ] **2.6** `src/jupiter/idl.json` — заморожений Jupiter v6 IDL ⏱ 15m → 2.5
  ✅ Файл присутній, валідний JSON
- [ ] **2.7** `src/jupiter/parser.ts` — Anchor decode → нормалізація args → тести 2.5 зелені ⏱ 120m → 2.6
  ✅ Всі 5 тестів зелені

### Kamino parser (TDD)
- [ ] **2.8** `tests/kamino.test.ts` — failing тести для 5 fixtures ⏱ 60m → 2.4
  ✅ 5 тестів падають
- [ ] **2.9** `src/kamino/idl.json` — заморожений Kamino Lend IDL ⏱ 15m → 2.8
  ✅ Файл присутній
- [ ] **2.10** `src/kamino/parser.ts` — decode + нормалізація → 2.8 зелені ⏱ 150m → 2.9
  ✅ Всі 5 тестів зелені

### Integration into ingestion
- [ ] **2.11** `apps/ingestion`: викликати `parseTransaction` після persist, оновити row з `instruction_name` + `parsed_args` ⏱ 45m → 2.7, 2.10, 1.11
  ✅ У Supabase зʼявляються рядки з `instruction_name='jupiter.swap'`
- [ ] **2.12** Фільтрація: ingestion витягує `wallet_pubkey` із `agents`, ігнорує tx не від цих wallets ⏱ 30m → 2.11
  ✅ Тільки tx від зареєстрованих агентів пишуться у БД

**Гейт Кінець E2:** ✅ ingestion парсить Jupiter та Kamino, фільтрує за зареєстрованими wallets, всі парсер-тести зелені.

---

## Епік 3 — REST API (Week 2 part 2)

**Мета:** Hono API з Privy auth, CRUD агентів, читання tx/alerts.

### Hono skeleton
- [ ] **3.1** `apps/api`: hono + @hono/node-server + tsx, `src/index.ts` з `/health` ⏱ 30m
  ✅ `curl localhost:3000/health` → 200 `{ok:true}`
- [ ] **3.2** `src/middleware/error.ts` — глобальний error handler з error format `{error:{code,message}}` ⏱ 30m → 3.1
  ✅ Тест: викликати throw → respond 500 з валідним JSON
- [ ] **3.3** `src/middleware/auth.ts` — Privy JWT validation, інжект `c.var.userId` ⏱ 60m → 1.0c
  ✅ Запит без token → 401, з валідним → next()
- [ ] **3.4** `src/lib/sse-bus.ts` — in-memory pub/sub (EventEmitter wrapper з типами) ⏱ 30m
  ✅ Unit-тест: subscribe → publish → receive

### Agents CRUD
- [ ] **3.5** `routes/agents.ts`: POST /api/agents (zod validation, insert у db, повертає agent) ⏱ 60m → 3.3, 1.6
  ✅ Інтеграційний тест: створити агента, перевірити що `user_id` з token
- [ ] **3.6** GET /api/agents (список усіх агентів юзера, ORDER BY created_at DESC) ⏱ 20m → 3.5
  ✅ Тест: 2 агента → endpoint повертає 2
- [ ] **3.7** GET /api/agents/:id (з recent_tx_count та last_alert) ⏱ 30m → 3.6
  ✅ Тест: створити агента + 1 tx → отримати з count=1
- [ ] **3.8** PATCH /api/agents/:id (часткове оновлення name/tags/webhook_url/alert_rules) ⏱ 30m → 3.7
  ✅ Тест: оновити name → перевірити у БД
- [ ] **3.9** DELETE /api/agents/:id (cascade delete tx/reasoning/alerts) ⏱ 20m → 3.8
  ✅ Тест: створити агента → DELETE → 204 → SELECT повертає порожньо

### Transactions read
- [ ] **3.10** GET /api/agents/:id/transactions (cursor pagination, limit≤100) ⏱ 45m → 3.9
  ✅ Тест: 150 tx → 2 сторінки по 100, наступний cursor валідний
- [ ] **3.11** GET /api/transactions/:signature (з reasoning_logs join) ⏱ 30m → 3.10
  ✅ Тест: tx без reasoning → reasoning_logs=[]

### Alerts read
- [ ] **3.12** GET /api/alerts (filter agent_id?, severity?, from/to) ⏱ 30m → 3.11
  ✅ Тест: filter by severity=critical → тільки critical

**Гейт Кінець E3:** ✅ API з повним CRUD агентів, читання tx + alerts. Інтеграційні тести зелені.

---

## Епік 4 — Reasoning Collector (Week 3 part 1)

**Мета:** OpenTelemetry OTLP/HTTP receiver, reasoning logs у БД, кореляція з tx.

### OTLP receiver
- [ ] **4.1** `apps/api`: deps `@opentelemetry/proto-grpc`, типи OTLP ⏱ 30m
  ✅ Імпорт працює, типи доступні
- [ ] **4.2** `routes/otlp.ts`: POST /v1/traces — приймає OTLP/HTTP JSON, парсить spans ⏱ 90m → 4.1
  ✅ Тест: відправити синтетичний OTLP payload → 200, parsed spans у логах
- [ ] **4.3** Auth для OTLP: span attribute `agent.token`, lookup у `agents.ingest_token` → отримати `agent_id`. Без token → 401 ⏱ 45m → 4.2, 3.5
  ✅ Тест: invalid token → 401; valid → 200
- [ ] **4.4** Persist: spans → `reasoning_logs` (trace_id, span_id, parent_span_id, start/end, attributes) ⏱ 60m → 4.3
  ✅ Тест: отримати 3-span trace → 3 рядки у БД
- [ ] **4.5** Кореляція: якщо span має attribute `solana.tx.signature` → зберегти у `reasoning_logs.tx_signature` ⏱ 20m → 4.4
  ✅ Тест: span з signature → field заповнено, без → null

### API: reasoning read
- [ ] **4.6** GET /api/agents/:id/reasoning (з фільтром по trace_id?) ⏱ 30m → 4.5
  ✅ Тест: 2 trace → filter by trace_id повертає тільки 1
- [ ] **4.7** Оновити GET /api/transactions/:signature — додати join з reasoning_logs (включно з повним span tree) ⏱ 30m → 4.6
  ✅ Тест: tx + 5 spans → endpoint повертає всі 5 з parent-child структурою

**Гейт Кінець E4:** ✅ Агент може відправити OTel trace → побачити у БД, корельований з tx.

---

## Епік 5 — Detector + Alerter (Week 3 part 2)

**Мета:** 5 rule-based правил, evaluator, Telegram delivery.

### Detector engine
- [ ] **5.1** `packages/detector`: типи `RuleContext`, `RuleResult`, `RuleDef` ⏱ 30m
  ✅ Експортуються, typecheck зелений
- [ ] **5.2** `src/index.ts` — `evaluate(ctx) → Alert[]`, реєстр правил ⏱ 30m → 5.1
  ✅ Unit: evaluate з 0 rules → []

### Rules (TDD)
- [ ] **5.3** `tests/slippage.test.ts` — failing тест ⏱ 20m → 5.2
- [ ] **5.4** `src/rules/slippage.ts` — slippage_spike (Jupiter swap > threshold%) ⏱ 30m → 5.3
  ✅ Тест зелений
- [ ] **5.5** `tests/gas.test.ts` failing → `src/rules/gas.ts` (fee > N × rolling 24h median per agent) ⏱ 60m → 5.2
  ✅ Зелений; уважно з division by zero
- [ ] **5.6** `tests/error-rate.test.ts` failing → `src/rules/error-rate.ts` (failed tx ratio > N% за 1h) ⏱ 45m → 5.2
  ✅ Зелений
- [ ] **5.7** `tests/drawdown.test.ts` failing → `src/rules/drawdown.ts` (1h P&L delta < -N%) ⏱ 60m → 5.2
  ✅ Зелений (потребує SOL price; для MVP — фіксована з env або останнього tx)
- [ ] **5.8** `tests/stale.test.ts` failing → `src/rules/stale.ts` (no activity > N min) ⏱ 30m → 5.2
  ✅ Зелений

### Detector runner у ingestion
- [ ] **5.9** `apps/ingestion/src/detector-runner.ts` — після кожного persist викликати `evaluate(ctx)` для tx-based правил ⏱ 45m → 5.4, 5.5, 5.6, 2.11
  ✅ Інтеграційний smoke: insert tx з slippage 50% → запис у `alerts`
- [ ] **5.10** `apps/ingestion/src/cron.ts` — periodic (1 min) eval для time-based правил (drawdown, error_rate, stale) ⏱ 60m → 5.7, 5.8
  ✅ Тест: запустити cron, агент без активності 31 хв → alert створено

### Alerter (Telegram first)
- [ ] **5.11** `packages/alerter`: типи `AlertChannel`, `DeliveryResult` ⏱ 15m
  ✅ Експортується
- [ ] **5.12** `src/telegram.ts` — `sendTelegram(chatId, alert)` через Bot API ⏱ 45m → 5.11, 1.0d
  ✅ Тест (mock fetch) + реальне відправлення у тестовий chat
- [ ] **5.13** `src/index.ts` — `deliver(alert, channel)` strategy router (telegram only у MVP) ⏱ 30m → 5.12
  ✅ Unit: deliver(.., 'telegram') викликає telegram.ts
- [ ] **5.14** Інтеграція у ingestion: після створення alert у БД → `deliver()` → оновити `delivered_at` ⏱ 45m → 5.13, 5.10
  ✅ E2E: симулювати slippage → з'являється повідомлення у Telegram чаті за <30 сек

**Гейт Кінець E5:** ✅ Аномалія → alert у БД → Telegram повідомлення. 5 правил працюють.

---

## Епік 6 — Dashboard (Week 4)

**Мета:** React SPA з Privy auth, agent list, drill-down, real-time tx + alerts.

### Vite setup
- [ ] **6.1** `apps/dashboard`: vite + react 18 + react-dom + react-router-dom + типи ⏱ 30m
  ✅ `pnpm --filter @agentscope/dashboard dev` → blank page на :5173
- [ ] **6.2** Tailwind 3.4 + базовий `index.css` + Inter font ⏱ 20m → 6.1
  ✅ Tailwind classes працюють
- [ ] **6.3** shadcn/ui CLI init, додати компоненти: Button, Card, Badge, Table, Dialog, Input, Toast ⏱ 30m → 6.2
  ✅ Імпорти з `@/components/ui/*` працюють
- [ ] **6.4** `src/lib/api-client.ts` — fetch wrapper з Privy token у header, типізований ⏱ 45m → 6.1
  ✅ Unit: mock fetch → `apiClient.get('/agents')` повертає типізований response

### Auth
- [ ] **6.5** `src/lib/privy.tsx` — PrivyProvider з config, hook `useAuth()` ⏱ 30m → 1.0c, 6.3
  ✅ Login через Privy → token доступний
- [ ] **6.6** ProtectedRoute wrapper, redirect на login якщо немає token ⏱ 20m → 6.5
  ✅ /agents без login → redirect

### Routes & layout
- [ ] **6.7** `App.tsx`: react-router з routes (/, /agents, /agents/:id, /alerts, /settings), Layout sidebar ⏱ 45m → 6.6
  ✅ Навігація між сторінками працює
- [ ] **6.8** `routes/agents.tsx` — список агентів через react-query, status badge, search ⏱ 60m → 6.7, 3.6
  ✅ Список рендериться з реальних даних
- [ ] **6.9** «Add Agent» dialog → POST /api/agents → invalidate query ⏱ 45m → 6.8, 3.5
  ✅ Створення агента у UI → з'являється у списку

### Agent detail view
- [ ] **6.10** `routes/agent-detail.tsx` — header з stats cards (tx count, success rate, SOL spent, last seen) ⏱ 60m → 6.7, 3.7
  ✅ Картки рендеряться з API даних
- [ ] **6.11** `components/tx-timeline.tsx` — chronological list of tx з icons по типу (swap/deposit/withdraw) ⏱ 75m → 6.10, 3.10
  ✅ Список з 50 tx скролиться, клік відкриває деталь
- [ ] **6.12** `components/reasoning-tree.tsx` — рекурсивний дисплей spans (parent-child), expand/collapse ⏱ 60m → 6.11, 4.7
  ✅ 3-рівневий trace відображається коректно
- [ ] **6.13** `components/pnl-chart.tsx` — Recharts time series (sol_delta cumulative за 24h) ⏱ 60m → 6.10
  ✅ Графік рендериться, tooltip показує значення

### SSE live updates
- [ ] **6.14** `apps/api`: GET /api/agents/:id/stream — SSE endpoint, що публікує tx/alert через sse-bus ⏱ 60m → 3.4, 3.10
  ✅ `curl -N localhost:3000/api/agents/:id/stream` отримує events
- [ ] **6.15** `apps/ingestion`: після persist tx + alert → publish у sse-bus (через HTTP POST до API чи shared in-memory? — IPC через DB LISTEN/NOTIFY) ⏱ 90m → 6.14
  ✅ tx у БД → SSE event на API → лог
- [ ] **6.16** `apps/dashboard/src/lib/sse.ts` — EventSource wrapper, hook `useStream(agentId)` ⏱ 45m → 6.14
  ✅ Unit: mock EventSource → events отримуються
- [ ] **6.17** Інтегрувати SSE у tx-timeline + status badge — нові tx з'являються без refresh ⏱ 45m → 6.11, 6.16
  ✅ Симулювати tx у БД → з'являється у UI <2с

### Інші views
- [ ] **6.18** `routes/alerts.tsx` — global alerts feed, filter by severity ⏱ 60m → 6.7, 3.12
  ✅ Список рендериться, filter працює
- [ ] **6.19** `routes/settings.tsx` — webhook URL + alert rule thresholds (форма, PATCH /api/agents/:id) ⏱ 60m → 6.7, 3.8
  ✅ Зміни зберігаються

### Polish
- [ ] **6.20** Loading states + error boundaries у всіх routes ⏱ 45m → 6.19
  ✅ React Query loading → skeletons; error → toast

**Гейт Кінець E6:** ✅ Повний дашборд: login → register agent → live tx → drill-down з reasoning → alerts.

---

## Епік 7 — SDK Integrations (Week 5a)

**Мета:** ElizaOS plugin (auto-instrumentation) + Solana Agent Kit helper, quickstart ≤5 хв.

### ElizaOS plugin
- [ ] **7.1** `packages/elizaos-plugin`: peer deps `@elizaos/core`, dev `@opentelemetry/sdk-node` ⏱ 20m
  ✅ Install OK
- [ ] **7.2** `src/otel-exporter.ts` — OTLP HTTP exporter з env-driven endpoint + agent token ⏱ 45m → 7.1, 4.3
  ✅ Unit: експортер шле POST на /v1/traces
- [ ] **7.3** `src/action-hooks.ts` — обертання ElizaOS action handlers у span (context propagation, prompt + output у attributes) ⏱ 90m → 7.2
  ✅ Тест: викликати action → span у експортера
- [ ] **7.4** `src/index.ts` — public Plugin export, auto-init у `setup()` ⏱ 30m → 7.3
  ✅ Імпорт `@agentscope/elizaos-plugin` як plugin працює
- [ ] **7.5** Інтеграційний тест з фейковим ElizaOS runtime → перевірка spans у тестовому receiver ⏱ 60m → 7.4
  ✅ Зелений

### Agent Kit SDK
- [ ] **7.6** `packages/agent-kit-sdk`: peer dep `solana-agent-kit` ⏱ 15m
  ✅ Install OK
- [ ] **7.7** `src/otel-setup.ts` — `initAgentScope({apiUrl, agentToken})` — глобальна OTel setup для Node ⏱ 45m → 7.6, 7.2
  ✅ Виклик інжектить tracer
- [ ] **7.8** `src/trace-decorator.ts` — `@traced('action_name')` decorator або `traced(fn, name)` wrapper ⏱ 60m → 7.7
  ✅ Тест: traced(asyncFn) повертає той самий результат, але з span
- [ ] **7.9** Приклад використання у `examples/agent-kit-trader.ts` ⏱ 30m → 7.8
  ✅ Файл компілюється, можна запустити

### Quickstart docs
- [ ] **7.10** `docs/QUICKSTART.md` — крок-за-кроком: register agent → install plugin → see tx ⏱ 60m → 7.5, 7.9
  ✅ Користувач може пройти за 5 хв (тестово)

**Гейт Кінець E7:** ✅ Один з SDK дає трейс у дашборд за ≤5 хв від cold start.

---

## Епік 8 — Demo agents + Landing (Week 5a part 2)

**Мета:** 3 робочих агенти на devnet, landing page, скрипти симуляції.

### Demo agents
- [ ] **8.1** `scripts/setup-devnet-wallets.ts` — генерація 3 keypairs (НЕ комітати), faucet airdrop ⏱ 30m
  ✅ 3 wallets з devnet SOL
- [ ] **8.2** `scripts/demo-trader.ts` — Jupiter swap loop (USDC↔SOL кожні 60с) з ElizaOS plugin instrumentation ⏱ 90m → 7.5, 8.1
  ✅ Запускається, swap виконується, у дашборді tx з'являються
- [ ] **8.3** `scripts/demo-yield.ts` — Kamino deposit → withdraw loop ⏱ 90m → 7.5, 8.1
  ✅ Цикл працює
- [ ] **8.4** `scripts/demo-nft.ts` — або Tensor mock, або просто SystemProgram.transfer з reasoning «купив NFT» (mock-режим у MVP) ⏱ 45m → 7.5, 8.1
  ✅ Цикл працює
- [ ] **8.5** `scripts/trigger-anomaly.ts` — форсує Jupiter swap зі slippage 50% для демо ⏱ 30m → 8.2
  ✅ Запуск → alert у Telegram <30с

### Landing page (Astro)
- [ ] **8.6** `apps/landing`: astro create + tailwind integration ⏱ 30m
  ✅ `pnpm --filter @agentscope/landing dev` → blank сторінка
- [ ] **8.7** `components/Hero.astro` — title, tagline, CTA "Get Started" → /dashboard ⏱ 45m → 8.6
  ✅ Hero рендериться
- [ ] **8.8** `components/Features.astro` — 6 feature cards (registry, ingestion, reasoning, detector, dashboard, SDKs) ⏱ 45m → 8.7
  ✅ Cards рендеряться
- [ ] **8.9** `components/DemoVideo.astro` — embed YouTube player (placeholder поки відео не знято) ⏱ 20m → 8.8
  ✅ Embed працює
- [ ] **8.10** `components/CTA.astro` — "Join Waitlist" → mailto: або Tally form ⏱ 30m → 8.9
  ✅ Працює

**Гейт Кінець E8:** ✅ 3 демо агенти живуть на devnet, landing на Vercel задеплоєно.

---

## Епік 9 — Polish + Submission (Week 5b)

**Мета:** деплой, відео, pitch deck, submission.

### Deploy
- [ ] **9.1** Railway: створити сервіс `agentscope-api` з GitHub repo, env vars з Supabase + Helius + Privy + Telegram ⏱ 30m
  ✅ `https://agentscope-api.up.railway.app/health` → 200
- [ ] **9.2** ‖ Railway: створити сервіс `agentscope-ingestion` (worker) ⏱ 20m → 9.1
  ✅ Логи показують ingestion активний
- [ ] **9.3** ‖ Railway cron: `agentscope-cron` (eval раз/хв) ⏱ 20m → 9.2
  ✅ Логи cron активні
- [ ] **9.4** Vercel: `apps/dashboard` як проект, env vars VITE_API_BASE_URL, VITE_PRIVY_APP_ID ⏱ 20m → 9.1
  ✅ `https://agentscope-dashboard.vercel.app` працює, login OK
- [ ] **9.5** ‖ Vercel: `apps/landing` як другий проект ⏱ 15m → 8.10
  ✅ `https://agentscope.vercel.app` працює
- [ ] **9.6** Supabase RLS final check: тестовий юзер не бачить чужих агентів ⏱ 30m → 9.4
  ✅ Підтверджено через 2 тестових акаунти

### Mainnet migration test (опційно, якщо лишається час)
- [ ] **9.7** Перевести `SOLANA_NETWORK=mainnet`, оновити Yellowstone URL, перевірити що ingestion бачить транзакції ⏱ 60m → 9.6
  ✅ Mainnet tx тече у БД (можна задеплоїти 1 реального агента)

### Demo video
- [ ] **9.8** Сценарій демо у `docs/DEMO-SCRIPT.md` (4 хв, 5 кроків з SPEC §6) ⏱ 30m
  ✅ Markdown готовий
- [ ] **9.9** Запис відео (OBS Studio) → 3-4 хв ⏱ 90m → 9.8, 9.6
  ✅ MP4 файл готовий
- [ ] **9.10** Заливка на YouTube unlisted → лінк у README + landing ⏱ 15m → 9.9
  ✅ Лінк працює

### Pitch deck
- [ ] **9.11** 10 слайдів у Google Slides / Canva (problem, solution, demo, market, competition, business model, traction, team, ask, close) ⏱ 120m
  ✅ PDF готовий
- [ ] **9.12** Експорт у PDF, заливка на Drive ⏱ 10m → 9.11
  ✅ Лінк готовий

### Submission
- [ ] **9.13** README final pass: badges, demo gif, quickstart, links ⏱ 45m → 9.10
  ✅ README ОК
- [ ] **9.14** Заповнити форму submission на Colosseum (project name, description, video, deck, repo, team) ⏱ 45m → 9.12, 9.13
  ✅ Submission прийнято до 2026-05-11

**Гейт Кінець E9:** ✅ Submission до Colosseum Frontier зроблено.

---

## Залежності між епіками

```
E1 (Foundation)
  ├─→ E2 (Parsers)
  │     └─→ E5 (Detector) [потребує ParsedTx]
  ├─→ E3 (API)
  │     ├─→ E4 (OTLP/Reasoning) [routes на тому ж Hono]
  │     └─→ E6 (Dashboard) [потребує API]
  └─→ E5 (Detector) [потребує DB]
        └─→ E6 (Dashboard) [показ alerts]

E4 → E6 (reasoning у UI)
E5 → E7 (SDK шле reasoning, який тригерить alerts через тот же flow)

E6 → E8 (landing може посилатися на dashboard URL)
E7 → E8 (demo agents використовують SDK)

E8 → E9 (deploy потребує всього)
```

## Що можна паралелити (на одній людині — context-switch вартує)

- **Тиждень 2:** після E2.10 (парсери готові) — можна почати E3 (API skeleton)
- **Тиждень 3:** E4 (OTLP) і E5 (detector) майже не залежать → можна чергувати по дню
- **Тиждень 4:** E6.1-6.7 (setup+layout) можна робити поки не готовий E4.7 (reasoning у API)
- **Тиждень 5:** E7 і E8 паралельні (різні файли, різні цілі)

---

## Cut-list (якщо часу замало)

Якщо до кінця Тижня 4 не встигаємо — ріжемо у такому порядку:

1. **E7.6-7.9** (Agent Kit SDK) — лишаємо тільки ElizaOS plugin
2. **E8.4** (NFT demo agent) — лишаємо trader+yield
3. **E6.18-6.19** (alerts route + settings UI) — заглушки
4. **E5.7** (drawdown rule) — найскладніше з правил
5. **E4.6-4.7** (reasoning UI side) — приймаємо логи, але не показуємо у дашборді
6. **E9.7** (mainnet test) — лишаємо тільки devnet

**НЕ ріжеться** (без цього MVP не існує):
- E1 (foundation)
- E2.5-2.7 (Jupiter parser — головний use-case)
- E3.5-3.10 (CRUD + tx read)
- E5.4 + E5.12-5.14 (slippage + Telegram delivery)
- E6.8-6.13 (agent list + detail)
- E8.2 (trader demo)
- E9.1-9.5 (deploy)
- E9.8-9.10 (відео)
- E9.14 (submission)

---

## Поточний стан

**Завершено:** 12 / 99 задач (Епік 1 closed for code).
**Поточна:** **2.1** (Парсер foundation — `packages/parser` deps + types).

**Юзеру паралельно:** див. `docs/USER-SETUP.md` (інструкції для 1.0a-e + деплой E9).
