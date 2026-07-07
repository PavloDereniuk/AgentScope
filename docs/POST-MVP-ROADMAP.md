# AgentScope — Post-MVP Roadmap

> **Status:** Hackathon scope (E1-E18) закритий, submission прийнято до Colosseum Frontier 2026-05-11. Переможців не отримали. Продукт живий, продовжуємо розвиток.
>
> **Filosofia:** post-hackathon — кожне покращення невелике (1-3 дні), окремий micro-release, окремий твіт. Без heavy епіків.
>
> **Дата створення:** 2026-05-22.
>
> **Принципи:**
> - Один пункт = одна цінність користувачу + один твіт. Жодних рефакторинг-only задач без user-visible delta.
> - **Strict no-deps** правило з CLAUDE.md залишається: нові npm пакети тільки з письмовим обґрунтуванням у комміті.
> - **Тести разом з кодом**, TDD strict тільки для `packages/parser` + `packages/detector`.
> - Якщо задача "пухне" > 3 днів — дробимо. Не дозволяємо хакатонському епіку-стилю на 20+ задач у post-MVP.
> - **Conventional commits** + кожен пункт = окремий git tag (v0.4.0, v0.5.0…) + GitHub Release notes.
>
> **Не у roadmap (свідомо out-of-scope):** custom alert rule builder UI, ML-based detection, mobile native app, SSO/RBAC, on-chain reputation, backfill історії, team management. Якщо хтось зі стейкхолдерів попросить — повертаємось і додаємо явно.

---

## Legend

| Маркер | Значення |
|---|---|
| `[ ]` | планується |
| `[~]` | в роботі |
| `[x]` | зроблено |
| `⏱` | оцінка (vibe-coding, ±50%) |
| `🎯` | твіт-кут — головна цінність у одному реченні |
| `📦` | приблизний release tag |

---

## Cluster E — Infra Hardening / Cost-Scaling 🔴 PRIORITY (grant-blocking)

> **Мета:** дати free-tier стеку (Supabase 500 MB + Helius free 1M credits) витримати грантову ціль **M3 = 50 агентів** без міграцій. **Цей кластер ПЕРЕДУЄ A/B/C/D** — без нього впремося в ліміти раніше за фічі.
>
> **Чому пріоритет (дані з [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md), 2026-06-01):** **зараз** першим впирається НЕ storage, а **Helius getBalance-cron на ~23 агентах** (виклик на кожного агента щоцикл 60с, кеш не допомагає, не батчиться). Storage на 50 агентів теж тісний (~11д retention зараз). Обидва лагодяться дешево — нижче.
>
> Повна модель місткості, формули й таблиці стель — у [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md).

### E.1 — getBalance батчинг (getMultipleAccounts) 🔴 НАЙКРИТИЧНІШЕ
- [x] **E.1** Замінити per-agent `getBalance` у балансовому фетчері на один `getMultipleAccounts` (до 100 акаунтів/виклик) на cron-цикл. Зараз 50 агентів = 50 викликів/цикл; стає 1. Зберегти fallback-абстейн на null при RPC-помилці
  ⏱ 1 день · 📦 **v0.4.3 (2026-06-01)** · 🎯 *"AgentScope just cut its RPC bill ~50×. Wallet-balance checks for every monitored agent now batch into a single getMultipleAccounts call per cycle — same low-fuel alerts, a fraction of the credits. Free-tier scaling, done right."*
  **Файли:** [apps/ingestion/src/balance-fetcher.ts](../apps/ingestion/src/balance-fetcher.ts) (`createBalanceFetcher` → `{ fetch, primeBalances }`, chunked `getMultipleAccountsInfo`) · [apps/ingestion/src/cron.ts](../apps/ingestion/src/cron.ts) (`CronDeps.primeBalances`, праймить увесь список гаманців на старті циклу) · [apps/ingestion/src/index.ts](../apps/ingestion/src/index.ts) (wire) · +7 tests (6 batch-prime + 1 cron)
  **Ефект:** Helius-стеля 23 → сотні агентів. **Без цього грантова M3 не лізе у free-tier.**
  **Дизайн-відхилення від roadmap:** detector `BalanceFetcher` лишено single-wallet (НЕ multi-wallet, як планувалось). Батч живе у ingestion-шарі через prime-cache, а не у per-agent rule — `low_balance` лишається простим і RPC-agnostic. Detector не чіпали взагалі.

### E.2 — Тримінг raw_logs
- [x] **E.2** (2026-06-03) Асиметричний cap замість плоских 200: **20 рядків на success, 200 на failure**. `capRawLogs(rawLogs, success)` + `RAW_LOGS_LIMIT_SUCCESS/FAILURE`. Повні логи лишаються доступні через RPC; failed tx тримає повніший head+tail (саме там діагностика). Гібрид з roadmap-опцій («зменшити ліміт» + «failed-only»)
  ⏱ 0.5 дня · 📦 **v0.4.4 (push+tag pending)** · 🎯 *"Storage diet: AgentScope now keeps only the log lines that matter — full traces on failures, slim on success. ~2.5× more transaction history in the same footprint. Your free tier goes further."*
  **Файли:** [apps/ingestion/src/persist.ts](../apps/ingestion/src/persist.ts) (`capRawLogs` pure helper + два ліміти, замість inline `RAW_LOGS_LIMIT`) · [apps/ingestion/tests/persist.test.ts](../apps/ingestion/tests/persist.test.ts) (новий, 8 тестів) · CHANGELOG [Unreleased]
  **Ефект:** ~10× на великих swap-логах, ~2.5× по таблиці (2.5 KB → ~1 KB/tx) → 50 агентів @ ~26д retention.
  **Дизайн-рішення:** винесено у чистий експортований helper (тестується без PGlite — persist.ts раніше взагалі не мав тестів). Success limit 20 (дашборд happy-path не дивиться порядково), failure 200 (tail = primary diagnostic). `parsed ? capRawLogs(...) : []` — коли tx не розпарсено, логів нема. No schema change (той самий jsonb shape).

### E.3 — Retention enable + storage monitoring
- [~] **E.3** (runbook done 2026-06-05; prod env = owner action) Виставити `TX_RETENTION_MONTHS=1` на prod ingestion (env, без коду). Додати storage-метрику + Helius credit-meter нагадування у runbook
  ⏱ 0.5 дня · 📦 **v0.4.5** · 🎯 *(internal, не обов'язково твіт — ops)*
  **Зроблено (docs):** [docs/DEPLOY.md](DEPLOY.md) §8 «Storage & cost hygiene» — як читати DB size / Helius credits / ingest lag, decision-rule для `TX_RETENTION_MONTHS` (0 < 300 MB → 1 при ~350-400 MB; чому не 3), Alchemy fallback.
  **Storage-метрика:** НЕ робив окремий `/metrics` — human-facing DB size вже на admin `/infra` (F.1); Prometheus-експозиція належить B.5 (не дублюю). Коли робимо B.5 — додаємо `agentscope_db_bytes` там.
  **Залишок (owner action):** виставити `TX_RETENTION_MONTHS` на Railway ingestion коли prod-DB ~350-400 MB (зараз тиску нема). Це видалення історії tx → свідоме рішення власника, не роблю мовчки.
  **Залежність:** партиційний roll-forward (вже в git) має працювати ≥1 цикл перед увімкненням drop. ✅ задоволено (shipped 2026-06).

### E.4 — archiveThenDrop (історія поза 500 MB)
- [ ] **E.4** Перед `DROP` партиції у `dropOldPartitions` — експортувати її у стиснутий Parquet/CSV.gz у Supabase Storage (окремий 1 GB free, не рахується проти DB) або Cloudflare R2 (10 GB free). Дашборд тягне історію on-demand. **Складність:** перший storage-egress flow, потребує обґрунтування dep якщо Parquet-lib
  ⏱ 2 дні · 📦 **v0.5.0-infra** · 🎯 *"Your agent's full history, forever — without paying for a bigger database. AgentScope now archives aged transactions to cold object storage before pruning the hot table. Query any month, keep the free tier lean."*
  **Файли:** [apps/ingestion/src/partition-maintenance.ts](../apps/ingestion/src/partition-maintenance.ts) `archiveThenDrop` · новий `apps/ingestion/src/archive.ts` · опц. `apps/api` read-from-archive route
  **Залежність:** E.2 (менші logs = менші архіви).

### E.5 — Прибрати дублювання parsed_args._all
- [x] **E.5** (2026-06-05) `_all` тепер компактний outline `{index, programId, name}` без per-hop `args` (`compactInstructionOutline`). Раніше ніс повні args кожної інструкції — дублював primary args (вже на top-level) + пхав кожен route_plan у jsonb на multi-hop Jupiter. Споживачів `_all`/args нема: tx-drawer не має поля `parsedArgs`, детектор-правила читають лише top-level primary args
  ⏱ 0.5 дня · 📦 **v0.4.6 (2026-06-05, released)** · 🎯 *(internal/storage — опц. твіт)*
  **Файли:** [apps/ingestion/src/persist.ts](../apps/ingestion/src/persist.ts) (`compactInstructionOutline` pure helper + `InstructionOutlineEntry`) · [apps/ingestion/tests/persist.test.ts](../apps/ingestion/tests/persist.test.ts) (+3 тести) · CHANGELOG [Unreleased]
  **Ефект:** ще ~15-20% storage на swap-heavy агентах. No schema change (той самий jsonb shape). Gate: ingestion 68/68 (+3), lint+typecheck 18/18 clean.

### E.7 — Transient DB-hang після редеплою (Supabase transaction pooler) 🔴 ПРІОРИТЕТ — deploy-safety
- [x] **E.7** (2026-06-15, ПОВНІСТЮ ЗАКРИТО) Після кожного редеплою api на Railway зависають усі `/api/*` на ~30с (DB-запити таймаутять, `/health` ок) — старий контейнер не відпускає конекшени до Supabase, новий + ingestion разом перевищують ліміт пулу. Тимчасовий лік: **Restart api** вручну на Railway. Durable-фікс: `DATABASE_URL` → **Supabase transaction pooler** (порт 6543, pgbouncer) + `prepare: false` у [packages/db/src/client.ts](../packages/db/src/client.ts) (env-gated, щоб direct-connection не втрачав prepared statements). Зачіпає **і api, і ingestion** — окрема акуратна задача, не просто «свап URL».
  ⏱ 0.5 дня · 📦 **v0.4.7** · 🎯 *(internal/ops — без твіту)*
  **Пріоритизовано 2026-06-10:** кожен deploy без цього фіксу = ~30с деградація для всіх активних юзерів. При зростанні builders (грантова M2+) стає все більш помітним. Виявлено 2026-06-02 під час викочування admin-панелі (Cluster F).
  **Підтверджено 2026-06-15:** [packages/db/src/client.ts:38](../packages/db/src/client.ts) має авто-детекцію `:6543` → `prepare: false`. Railway вже має transaction pooler URL (порт 6543) на api + ingestion. Закрито без окремого коміту.

**Cluster E total:** ~5 днів, 6 micro-releases (v0.4.3 → v0.5.0-infra). **E.1 + E.2 — must-have для M3 на free-tier; E.7 — deploy-safety (пріоритет до залучення нових юзерів).**

---

## Cluster A — Detection + Parser Expansion

> **Мета:** ширша покривність "що агент робить" і "коли поводиться дивно". Кожне правило = `packages/detector/src/rules/` + TDD; кожен парсер = `packages/parser/src/<protocol>/` з IDL + real-mainnet fixtures (як Jupiter v6/Kamino).

### A.1 — MEV sandwich detector
- [x] **A.1** `slippage_sandwich` rule — Jupiter swap де (a) `outAmount` < `quotedOutAmount × (1 - threshold)` І (b) у тому самому slot/block є зустрічна swap-tx з вищим priority fee
  ⏱ 2 дні · 📦 **v0.4.0 (2026-05-22)** · 🎯 *"AgentScope now detects when your AI agent gets sandwiched by MEV bots. We compare quoted vs actual outAmount against neighbours in the same slot — first observability tool that calls out the attack inline."*
  **Commits:** [`19cf1c7`](https://github.com/PavloDereniuk/AgentScope/commit/19cf1c7) (Phase 1, evidence-only) · [`71b6dc7`](https://github.com/PavloDereniuk/AgentScope/commit/71b6dc7) (Phase 2, slot-neighbour augmentation)
  **Файли:** [packages/detector/src/rules/sandwich.ts](../packages/detector/src/rules/sandwich.ts) + 24 tests · [apps/ingestion/src/slot-neighbours.ts](../apps/ingestion/src/slot-neighbours.ts) + 6 tests · `packages/shared/{types,schemas,format-alert}.ts` · DB migration 0011

### A.2 — Wallet balance low-fuel alert
- [x] **A.2** `low_balance` cron rule — після persistTx обчислити поточний SOL balance агента; якщо `< threshold` (default 0.005 SOL) → alert severity=warning, escalate=critical при `< 0.001`
  ⏱ 1 день · 📦 **v0.4.1 (2026-05-25)** · 🎯 *"Your agent stopped trading at 3am? Maybe it just ran out of SOL. AgentScope now alerts you before the wallet hits empty — not after the first failed tx."*
  **Файли:** [packages/detector/src/rules/low-balance.ts](../packages/detector/src/rules/low-balance.ts) + 13 tests · [apps/ingestion/src/balance-fetcher.ts](../apps/ingestion/src/balance-fetcher.ts) + 7 tests · `packages/shared/{types,schemas,format-alert}.ts` · DB migration 0012

### A.3 — Runaway loop detector
- [x] **A.3** `tx_rate_anomaly` cron rule — sliding window 5 хв: якщо tx-rate > N (default 30/min, env override) → alert. Захист від zacycled retry loop'ів і LLM-decisions, що не зупиняються
  ⏱ 1 день · 📦 **v0.4.2 (2026-05-29)** · 🎯 *"Worst-case for any agent: stuck in a retry loop, draining gas. We catch it at >30tx/min — kill switch before it costs you 100$."*
  **Файли:** [packages/detector/src/rules/runaway.ts](../packages/detector/src/rules/runaway.ts) + 11 tests · `packages/shared/{types,schemas,format-alert}.ts` · DB migration 0013

### A.4 — Raydium AMM/CLMM parser
- [x] **A.4** (commit `5d6678b`, 2026-06-23) Парсер для Raydium v4 AMM + CLMM (`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`, `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`). 10 mainnet fixtures (5 AMM + 5 CLMM), IDL-like doc JSON, TDD — 14/14 tests зелені.
  ⏱ 3 дні · 📦 v0.5.0 · 🎯 *"Raydium swaps are now first-class in AgentScope — instruction-name, in/out mints, slippage, pool ID. Your AMM-using agents finally show up with real semantics instead of a generic 'unknown program' row."*
  **Файли:** `packages/parser/src/raydium/{idl.json, parser.ts}` · `packages/parser/tests/raydium.test.ts` · `packages/parser/src/{dispatcher,index}.ts`
  **Дизайн-нотатки:** AMM v4 — non-Anchor, перший байт = instruction code (9=SwapBaseIn, 11=SwapBaseOut), args at fixed offsets. CLMM — Anchor, swap_v2 disc=sha256("global:swap_v2")[..8]=`2b04ed0b1ac91e62`, mints at accounts[11/12]. AMM v4 direct calls рідкісні (~10% від txs у програми, 90% CPI-only від Jupiter). tx-timeline icon — post-MVP (dashboard окремо).

### A.5 — Orca Whirlpools parser
- [x] **A.5** (commit pending, 2026-07-01) Парсер для Orca Whirlpools (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`). swap/swap_v2/two_hop_swap/two_hop_swap_v2. 5 mainnet fixtures, 11 TDD тестів, 18/18 turbo зелені.
  ⏱ 3 дні · 📦 v0.5.1 · 🎯 *"Whirlpools parsing shipped. AgentScope now reads Orca, Jupiter, Raydium and Kamino — that's >90% of Solana DEX volume covered for agent observability."*
  **Файли:** [packages/parser/src/orca/idl.json](../packages/parser/src/orca/idl.json) · [packages/parser/src/orca/parser.ts](../packages/parser/src/orca/parser.ts) · [packages/parser/tests/orca.test.ts](../packages/parser/tests/orca.test.ts) · 5 fixtures (orca-1..5)
  **Дизайн-нотатки:** swap (v1) = 11 accounts, disc f8c69e91e17587c8, mints via tokenAccountMints[tokenOwnerAccount{A,B}] + aToB flag. swap_v2 = 15+ accounts, disc 2b04ed0b1ac91e62, direct mints at acc[5]/acc[6], pool at acc[4]. two_hop_swap — owner net flow fallback для мінтів. scripts/fetch-orca-fixtures.ts збирає нові fixtures.

### A.6 — Drift Protocol parser (perps)
- [ ] **A.6** Парсер для Drift v2 (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) — placeOrder, fillOrder, cancelOrder. **Складність:** perps мають свою market-index model
  ⏱ 3 дні · 📦 v0.5.2 · 🎯 *"AgentScope now parses Drift perp orders — leverage agents are finally observable end-to-end. Place, fill, cancel — all with mark price, market index, and size."*
  **Файли:** `packages/parser/src/drift/{idl.json, parser.ts}` + tests

### A.7 — Marinade liquid staking parser
- [x] **A.7** (2026-07-07) Парсер для Marinade — `deposit`, `liquid_unstake`, `order_unstake`, `claim`. 12 TDD тестів, 6 mainnet fixtures (2 deposit, 2 liquid_unstake, 1 order_unstake, 1 claim). Стейкінг має простіший shape ніж DEX — тільки SOL↔mSOL, тому args плоскі (`amountLamports`/`msolAmount` + `stateAddress`), без swap-стилю `{inputMint,outputMint}`.
  ⏱ 2 дні · 📦 v0.5.3 · 🎯 *"Marinade staking now visible. Yield-strategy agents that route between Kamino and Marinade — fully observable from a single dashboard."*
  **Файли:** [packages/parser/src/marinade/idl.json](../packages/parser/src/marinade/idl.json) · [packages/parser/src/marinade/parser.ts](../packages/parser/src/marinade/parser.ts) · [packages/parser/tests/marinade.test.ts](../packages/parser/tests/marinade.test.ts) · [scripts/fetch-marinade-fixtures.ts](../scripts/fetch-marinade-fixtures.ts)
  **🔴 Виправлення адреси програми (важливо):** оригінальний roadmap-запис `MarBmsSgKXdrN1egZf5sqe1TMThiYsCfVuvAJBbQNTQ` — **неіснуючий акаунт на mainnet** (`getAccountInfo` → null, перевірено). Правильна адреса `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` — звірена проти `docs.marinade.finance/developers/contract-addresses` + живого `getAccountInfo` (executable BPF program) ПЕРЕД написанням парсера. Схоже, попередня сесія записала roadmap-адресу з пам'яті без верифікації — урок: завжди звіряти program ID проти on-chain стану чи офіційної документації, ніколи з training-пам'яті.
  **Дизайн-нотатки:** `claim` не має числового аргументу в instruction data (лише 8-байтовий дискримінатор) — сума криється в ticket-акаунті, тому парсер повертає `reservePda`+`ticketAccount` замість суми. `order_unstake` додано понад точний roadmap-опис (deposit/liquidUnstake/claim) — без нього `claim` не мав би парного інструменту створення тікета delayed-unstake; обидва мають однаковий shape (disc + u64 msol_amount), тому додавання дешеве. `deposit_stake_account` (10 випадків у 463 tx сканування) свідомо НЕ реалізовано — поза точним описом задачі. accounts[0]=state підтверджено на всіх 4 інструкціях проти офіційної docs-адреси; `liquid_unstake`'s accounts[4]=treasuryMsolAccount і `claim`'s accounts[1]=reservePda також збігаються з офіційними docs-адресами один-в-один.

### A.8 — Priority fee anomaly rule
- [x] **A.8** `priority_fee_spike` rule — fee у tx > N × median fee для цього програма за останні 24h. Захист від тихих overpay-bug'ів (наприклад, неправильно встановлений ComputeBudget instruction)
  ⏱ 1 день · 📦 v0.5.4 · 🎯 *"Your agent silently paid 200x normal priority fee on this swap. AgentScope now flags it — most observability tools don't even surface compute budget."*
  **Файли:** `packages/detector/src/rules/priority-fee.ts` + tests · Reuse `gas_spike` median-query pattern

**Cluster A total:** ~16 днів, 8 micro-releases (v0.4.0 → v0.5.4)

---

## Cluster B — Notification Channels + Developer Experience

> **Мета:** зняти "Telegram only" як блокер з SPEC §7; додати DX-фічі що роблять self-host і CI/CD інтеграцію легкою.

### B.1 — Discord webhook channel
- [ ] **B.1** ⏸ **(відкладено — робити в останню чергу після B.2-B.8)** Новий channel `discord` у `packages/alerter` — POST до Discord webhook URL з embed shape (severity-color, title, fields). Per-agent `discordWebhookUrl` поле у `agents` таблиці
  ⏱ 2 дні · 📦 v0.6.0 · 🎯 *"Discord alerts shipped. Drop your channel webhook into AgentScope settings, get rich embeds (color-coded severity, parsed tx, reasoning summary). No bot setup — just a webhook URL."*
  **Файли:** `packages/alerter/src/discord.ts` + tests · `packages/db` migration · `apps/api` routes/agents PATCH · `apps/dashboard/src/routes/settings.tsx` Notifications card

### B.2 — Slack webhook channel
- [ ] **B.2** Дзеркало B.1 — Slack incoming webhook з block-kit shape
  ⏱ 1 день · 📦 v0.6.1 · 🎯 *"Slack channel support — same flow as Discord. Your agent alerts now reach wherever your team lives."*
  **Файли:** `packages/alerter/src/slack.ts` + tests · `apps/dashboard/src/routes/settings.tsx`

### B.3 — Webhook HMAC signing
- [ ] **B.3** Підписувати webhook payloads (existing webhook channel) з `X-AgentScope-Signature: sha256=...` header, секрет генерується при створенні агента (`agents.webhook_secret`), показується раз у settings. Доку у QUICKSTART
  ⏱ 1 день · 📦 v0.6.2 · 🎯 *"Webhook security: every payload now signed with HMAC-SHA256. Verify the signature before trusting incoming AgentScope alerts — protects against spoofed webhook fires."*
  **Файли:** `packages/alerter/src/webhook.ts` · `packages/db` migration · `apps/dashboard/src/routes/settings.tsx` "regenerate secret"

### B.4 — Email digest (daily summary)
- [ ] **B.4** Daily email через Resend free tier (3000/mo) з підсумком: tx count, top-3 alerts, P&L delta. Opt-in per agent. **Складність:** перший зовнішній SaaS dep — потребує письмового обґрунтування у комміті (per CLAUDE.md)
  ⏱ 2 дні · 📦 v0.6.3 · 🎯 *"Daily email digest for your agents. One line of opt-in, get a tight summary every morning: tx count, alerts fired, P&L delta. Even when you don't open the dashboard."*
  **Файли:** `apps/ingestion/src/email-digest.ts` (cron worker, 09:00 UTC) · `packages/alerter` extension · `apps/dashboard/src/routes/settings.tsx`

### B.5 — Prometheus /metrics endpoint
- [x] **B.5** (commit `c64096b`, 2026-06-26) `GET /metrics` на API — текстовий Prometheus exposition format: `agentscope_tx_total{user,agent}`, `agentscope_alerts_total{severity,rule}`, `agentscope_reasoning_spans_total`, `agentscope_ingest_lag_seconds`. **Self-hosters' must-have**
  ⏱ 1 день · 📦 **v0.6.4** · 🎯 *"AgentScope now exposes /metrics in Prometheus format. Self-hosters: pipe it to Grafana, build your own dashboards. We eat our own dogfood (observability for the observability tool)."*
  **Файли:** [apps/api/src/routes/metrics.ts](../apps/api/src/routes/metrics.ts) (no auth — internal scrape) · [apps/api/tests/metrics.test.ts](../apps/api/tests/metrics.test.ts) (7 тестів) · zero new deps (string builder)

### B.6 — GitHub Action: agent health check
- [ ] **B.6** Reusable workflow `agentscopehq/agent-health-check@v1`: запускається cron'ом у юзера, перевіряє `GET /api/agents/:id` → `lastSeenAt` < N min → success/fail. Готова action для CI/CD інтеграції
  ⏱ 1 день · 📦 v0.6.5 · 🎯 *"Add `uses: agentscopehq/agent-health-check@v1` to your repo's workflow. Get a fail in CI when your AI agent goes silent. Zero infra, one line of YAML."*
  **Файли:** новий repo `agentscopehq/agent-health-check` · README + action.yml · Просто bash + curl + jq, не TypeScript

### B.7 — Docker self-host image
- [ ] **B.7** Multi-stage `Dockerfile` на корені — збирає api + ingestion + dashboard у один image, env-driven config, default postgres connection. `docker compose up` → працює локально з Supabase-compatible Postgres
  ⏱ 2 дні · 📦 v0.7.0 · 🎯 *"AgentScope is now one `docker compose up` away. Self-host on your laptop, your VPS, your homelab — all the observability, none of the SaaS. (We still recommend our cloud for prod, but the choice is yours.)"*
  **Файли:** `Dockerfile` · `docker-compose.yml` · `docs/SELF-HOST.md` · CI build push на GHCR

### B.8 — Agent ingest-token rotation
- [ ] **B.8** `POST /api/agents/:id/rotate-token` — генерує новий `ingest_token`, інвалідує старий (grace period 1h). Settings UI кнопка "Rotate token"
  ⏱ 1 день · 📦 v0.7.1 · 🎯 *"Compromised an agent's ingest token? Rotate it from the dashboard with one click — 1h grace window so your running agent keeps emitting while you redeploy. Security 101 for production agents."*
  **Файли:** `apps/api/src/routes/agents.ts` POST endpoint · `apps/dashboard/src/routes/settings.tsx`

**Cluster B total:** ~11 днів, 8 micro-releases (v0.6.0 → v0.7.1)

---

## Cluster C — Dashboard UX + Growth/Embed

> **Мета:** покращити денний flow user-а у дашборді + дати маркетинг-сурфейс що працює без логіну (badges, embeds, public pages).
>
> **Пріоритизовано 2026-06-10:** C.0 і C.0b передують решті Cluster C — закривають gap між реєстрацією і першим «ага-моментом» + дають acquisition-поверхню без логіну.

### C.0 — Activation banner: «Step 2 — integrate your agent» ✅ SHIPPED v0.4.8
- [x] **C.0** Коли юзер зареєстрував агента, але ще не відправив жодного span/tx (`lastSeenAt == null` і `txCount24h == 0`) — показувати persistent yellow-tint banner на agent-detail: *«Step 2: copy your ingest token in Settings → add 3 lines to your agent → [Quick guide →]»*. Зникає автоматично після першого span/tx (або після ручного dismiss). Прямо закриває gap між «зареєстрував» і «побачив перші дані» — зараз юзер сам здогадується що йти у Settings і де знайти токен.
  ⏱ 2 год · 📦 **v0.4.8** · 🎯 *"Registered your first agent? Here's the token, here's the 3-line setup — right where you are. No docs-hunting. Banner disappears the moment your agent checks in."*
  **Файли:** `apps/dashboard/src/routes/agent-detail.tsx` (banner conditional on `lastSeenAt == null && txCount24h == 0`) · `apps/dashboard/src/components/ActivationBanner.tsx` (reuse існуючий warn-tint з PausedBadge palette)

### C.0c — Onboarding checklist (3-step activation flow) ✅ SHIPPED 2026-06-15
- [x] **C.0c** Замінила `ActivationBanner` на повноцінний 3-кроковий `OnboardingChecklist` на `/agents/:id`. Крок 1 ✅ реєстрація, Крок 2 ⬤ wire up SDK + вбудований copy-token + npm-команда, Крок 3 ○ перший трейс. Авто-dismiss через 2.5с після приходу трафіку (юзер бачить success state). Warn-тінт до трафіку → accent-тінт після.
  📦 **v0.4.10** · 🎯 *"New agent? Here's what to do next — right on the page. Token, install command, status. Disappears automatically the moment your agent phones home."*
  **Файли:** `apps/dashboard/src/components/OnboardingChecklist.tsx` (новий) · `apps/dashboard/src/routes/agent-detail.tsx` (заміна ActivationBanner → OnboardingChecklist, `showChecklist = !bannerDismissed`, `hasTraffic` prop)

### C.0b — Public read-only demo agent (E19) ✅ SHIPPED v0.4.9 · fe65325
- [x] **C.0b** Один `PUBLIC_DEMO_AGENT_ID` у env → `/share/:id` читається без Privy-логіну. Окрема public Zod schema без sensitive fields (`ingestToken`, `telegramChatId`, `webhookUrl`, `alertRules.pausedUntil`). Landing page отримує другий CTA «View live demo →». Sticky «Sign in to monitor your own agent» банер на `/share/:id`. Per-IP rate limit (окремий limiter від auth-endpoints). Інші agent-id → 404 без existence-oracle.
  ⏱ 4.5 год · 📦 **v0.4.9** · 🎯 *"See AgentScope without signing up. Live PriceWatcher agent, real mainnet trades, real alerts. Click 'View live demo' from the landing — no login gate."*
  **Файли:** `apps/api/src/routes/public-agent.ts` · `apps/dashboard/src/routes/share.tsx` · `apps/landing/src/components/Hero.astro` · `apps/api/src/config.ts`
  **⚠ Production action:** виставити `PUBLIC_DEMO_AGENT_ID=<uuid>` на Railway api — без env var всі `/public/*` → 404.
  **Залежність:** backend C.0b = prerequisite для C.7 (embeddable widget).

### C.1 — Full light theme
- [ ] **C.1** Зараз `apps/dashboard` dark-first з Tweaks-panel свопперами. Додати повноцінну light palette у `--bg-light-*` змінні, default OS-prefers-color-scheme detection, toggle у top bar
  ⏱ 1 день · 📦 v0.7.2 · 🎯 *"Light theme shipped. Same OKLCH discipline, just inverted. Auto-switch based on `prefers-color-scheme`. Some of us read dashboards at 7am — we get it."*
  **Файли:** `apps/dashboard/src/index.css` light vars · `hooks/use-theme.ts` · `components/shell/TopBar.tsx` toggle

### C.2 — Mobile-responsive agent detail
- [ ] **C.2** `routes/agent-detail.tsx` зараз рве layout на мобільному (4-col KPI strip + side-by-side cards). Перевести на stack-first нижче 768px, sidebar → hamburger drawer
  ⏱ 2 дні · 📦 v0.7.3 · 🎯 *"AgentScope on mobile, properly. Drill into your agent from the bus — KPI strip, tx feed, reasoning tree all stack cleanly under 768px. Drawer-based sidebar. The future is on your phone."*
  **Файли:** `apps/dashboard/src/routes/agent-detail.tsx` · `components/Layout.tsx` mobile drawer · CSS breakpoints

### C.3 — Keyboard shortcuts overlay (?)
- [ ] **C.3** Натиснення `?` → modal з cheat sheet (⌘K search, J/K navigate, E expand, X close drawer, A go agents, R reasoning, S settings). Глобальний listener у Layout
  ⏱ 1 день · 📦 v0.7.4 · 🎯 *"Press `?` anywhere in AgentScope dashboard for a shortcut cheat sheet. J/K to nav rows, E to expand, ⌘K to jump. Built for users who never reach for the mouse."*
  **Файли:** `apps/dashboard/src/components/ShortcutsOverlay.tsx` · `components/Layout.tsx` keybind

### C.4 — Side-by-side trace compare
- [ ] **C.4** У Reasoning Explorer — checkbox по 2 trace-и, кнопка "Compare" → split view: ліворуч/праворуч span trees, diff-highlighted attributes (різні `decision.action`, `price_usd` дельта)
  ⏱ 2 дні · 📦 v0.7.5 · 🎯 *"Why did the agent decide A on Monday and B on Tuesday with the same market state? Side-by-side trace compare in AgentScope shows you exactly which attribute changed. Built for debugging non-deterministic LLMs."*
  **Файли:** `apps/dashboard/src/routes/reasoning.tsx` selection state · `components/TraceCompareView.tsx`

### C.5 — Agent tags filter + tag cloud
- [ ] **C.5** Tags вже у `agents.tags jsonb`, але UI не використовує. Додати tag-chip filter у `/agents` toolbar (multi-select), показувати tag cloud у sidebar (top-10 tags counts)
  ⏱ 1 день · 📦 v0.7.6 · 🎯 *"Organize agents with tags — filter your list by `prod`/`testnet`, `strategy:arb`, whatever you want. Tag-aware sidebar with top-10 cloud. Already in the DB, finally in the UI."*
  **Файли:** `apps/dashboard/src/routes/agents.tsx` filter · `components/TagCloud.tsx`

### C.6 — README status badge (shields.io)
- [x] **C.6** `GET /public/badge/:agentId` повертає shields.io-сумісний SVG (live/stale/failed). Користувач embed'ить `![status](https://api.agentscopehq.dev/public/badge/<id>)` у свій GitHub README
  ⏱ 1 день · 📦 **v0.7.7 (реалізовано раніше, підтверджено 2026-06-18)** · 🎯 *"Drop an AgentScope status badge into your agent's README — live green pulse when running, gray when stale. Same energy as 'CI passing', for AI agents. Markdown one-liner, no auth, cached at edge."*
  **Файли:** [apps/api/src/routes/public-badge.ts](../apps/api/src/routes/public-badge.ts) · [apps/api/tests/public-badge.test.ts](../apps/api/tests/public-badge.test.ts) (9 тестів) · Pure SVG string render, no deps · Mounted at /public (не /api/public — без bearer auth gate)
  **Залежність:** окрема endpoint без bearer auth — повторити паттерн з E19

### C.7 — Embeddable widget (iframe)
- [ ] **C.7** `/embed/agent/:id?theme=dark|light` — мінімальна сторінка з live KPI tile (tx 24h, status pulse, last alert). Призначення: blogs, Twitter cards, docs
  ⏱ 2 дні · 📦 v0.8.0 · 🎯 *"Embed your AgentScope agent's pulse anywhere. `<iframe src=\"agentscope.io/embed/agent/...\">` and you've got a live status tile in your blog post, your team docs, your portfolio. CSP-friendly."*
  **Файли:** `apps/dashboard/src/routes/embed-agent.tsx` (no auth) · API public read endpoints (reuse E19 sanitization)
  **Залежність:** E19 backend (public read routes)

### C.8 — Scalar/Swagger API docs
- [ ] **C.8** OpenAPI spec generated з Hono routes через `@hono/zod-openapi` (one new dep, justified — first-class API surface для third-party integrators). Served at `/docs` через Scalar
  ⏱ 2 дні · 📦 v0.8.1 · 🎯 *"AgentScope API now has interactive docs at api.agentscopehq.dev/docs. Built from the actual Zod schemas — no drift between spec and code. Try requests right in the browser, copy curl out, done."*
  **Файли:** Migration `@hono/zod-validator` → `@hono/zod-openapi` (incremental, one route at a time) · `apps/api/src/openapi.ts` · `apps/api/src/routes/docs.ts`

**Cluster C total:** ~12 днів, 8 micro-releases (v0.7.2 → v0.8.1)

---

## Cluster D — AI/LLM-powered Features

> **Мета:** використати Claude API для перетворення сирих даних агента у читабельні insights. Перші AgentScope-фічі що самі агентські.

### D.1 — Auto-tuning threshold suggestions
- [ ] **D.1** Cron-задача (раз/тиждень): для кожного агента порахувати fire-rate кожного rule за останні 7 днів. Якщо `slippage_spike` стріляє >12×/день — суджестити підвищити threshold. Banner у settings: "We suggest threshold X (you'd see 80% fewer alerts, miss 0 critical events based on historical data)"
  ⏱ 3 дні · 📦 v0.9.0 · 🎯 *"Your slippage threshold fires 14 alerts a day? AgentScope now analyzes your history and suggests calibrated values — keep critical signal, kill the noise. No ML, just honest statistics on YOUR agent's behavior."*
  **Файли:** `apps/ingestion/src/threshold-tuner.ts` cron · `apps/api/src/routes/agents.ts` GET tunings · `apps/dashboard/src/routes/settings.tsx` suggestion banner

### D.2 — LLM anomaly summary ("what happened?")
- [ ] **D.2** При кліку на alert → кнопка "Explain this" → POST до Claude API з контекстом (alert payload + correlated reasoning trace + tx parsed args + agent history snippet). Повертає 1 параграф в людській мові. Прив'язано до **per-user OpenAI/Anthropic key** (settings input) — щоб не з'їсти власник-бюджет. **Складність:** перший runtime-LLM call у проекті, потребує rate-limit + cache
  ⏱ 4 дні · 📦 v0.9.1 · 🎯 *"'Why did my agent buy at 5% above mid-price?' — click 'Explain' on any alert in AgentScope and get a one-paragraph plain-English summary. Combines the on-chain tx, the reasoning chain, and history. Built on Claude. Bring your own API key."*
  **Файли:** `apps/api/src/routes/explain.ts` · `packages/shared` LLM prompt template · `apps/dashboard/src/components/ExplainButton.tsx` · `apps/api/src/middleware/llm-cache.ts` (24h LRU по alert.id)

### D.3 — Reasoning quality score
- [ ] **D.3** Періодична оцінка (раз/добу) — для кожного агента подивитись на N останніх traces, обрахувати метрики: (a) avg depth (>5 spans = "thoughtful"), (b) decision-tx correlation rate (% traces з ≥1 `solana.tx.signature`), (c) variance у вхідних attributes (агент що завжди робить однакові свопи може бути не "AI"). Score 0-100 у agent header
  ⏱ 3 дні · 📦 v0.9.2 · 🎯 *"AgentScope's new Reasoning Quality Score: 0-100 per agent based on trace depth, decision-tx correlation, and behavior variance. Spot agents that drifted into deterministic-loop mode disguised as 'AI'. First metric of its kind for on-chain agents."*
  **Файли:** `apps/ingestion/src/quality-score.ts` cron · `packages/db` migration `agents.quality_score int` · `apps/dashboard/src/routes/agent-detail.tsx` score badge

### D.4 — Telegram bot conversational query
- [ ] **D.4** Розширити `apps/ingestion/src/telegram-bot.ts` — приймати команди `/status <agent>`, `/last-tx <agent>`, `/why <alert-id>`. Останнє reuse-ить D.2 (LLM explain). Без діалогу, тільки command-style
  ⏱ 2 дні · 📦 v0.9.3 · 🎯 *"AgentScope's Telegram bot now answers questions. `/status mybot` → live KPI. `/why alert_xyz` → LLM-powered explanation. Your agent observability now talks back, right in the chat where you got the alert."*
  **Файли:** `apps/ingestion/src/telegram-bot.ts` command dispatcher · reuse `apps/api` internal calls

**Cluster D total:** ~12 днів, 4 micro-releases (v0.9.0 → v0.9.3)

---

## Cluster F — Grant Ops / Admin Panel 🟢 (grant-driven)

> **Мета:** дати власнику (single-owner) платформний зріз метрик для звітності по гранту Solana Foundation Ukraine (M1=4 → M2=10 → M3=25 builders, deadline 2026-08-01). На відміну від per-user dashboard (Privy + RLS по `user_id`), адмінка агрегує **across усіх користувачів**.
>
> **Дизайн-рішення (зафіксовано 2026-06-02):**
> - Surface: новий `/admin` route у **існуючому** dashboard (НЕ окремий деплой) — soло-проєкт, зайвий Vercel = anti-pattern.
> - Auth: owner-gate через наявний `OWNER_PRIVY_DID_SET` (config.ts) — той самий allowlist, що вже обходить `MAX_AGENTS_PER_USER`. Жодного RBAC (SSO/RBAC лишається out-of-scope для multi-tenant; це single-owner feature).
> - Backend: `/api/admin/*` роути за `requireOwner` middleware (поверх `requireAuth`). Агрегації — патерн stats.ts, але БЕЗ `user_id`-фільтра (API-конекшн scoping робиться у коді, не в RLS).
> - `GET /api/me` → `{isOwner}` щоб не зашивати owner-DID у клієнтський бандл (нав показуємо тільки власнику).
> - **Перетин з B.5 (Prometheus `/metrics`):** `/api/admin/*` — human-facing версія тих самих агрегатів. Коли робимо B.5 — ділимо SQL-хелпери.
> - Білдер трекаємо у ДВОХ цифрах: **registered** (distinct users з ≥1 агентом) + **active** (≥1 tx або reasoning span). Власник вирішує, яку слати per-milestone.

### F.1 — Admin metrics API (owner-gated)
- [x] **F.1** (commit `3b7d136`, 2026-06-02) `requireOwner` middleware + `apps/api/src/routes/admin.ts` з endpoints: `/overview`, `/milestones`, `/growth`, `/infra`, `/builders`, `/alerts-breakdown`. `GET /api/me` → `{isOwner}`. Milestone-таргети + deadline через env (`ADMIN_MILESTONE_*`, дефолти 4/10/25 + 2026-08-01). Тести на PGlite: owner→200 / non-owner→403 / no-auth→401, коректність registered vs active підрахунку, milestone %, infra graceful-degrade.
  ⏱ 1.5 дня · 📦 **v0.5.0-admin** · 🎯 *(internal/ops — опц. твіт про «building in public: our grant milestone tracker»)*
  **Файли:** `apps/api/src/middleware/owner.ts` · `apps/api/src/routes/admin.ts` · `apps/api/src/config.ts` (milestone env) · `apps/api/src/app.ts` + `server.ts` (wire) · `apps/api/tests/admin.test.ts`

### F.2 — Admin panel UI (/admin)
- [x] **F.2** (commit `9bce183`, 2026-06-02) `/admin` route у dashboard з owner-gated нав (через `/api/me`). Компоненти: milestone progress-бари (M1/M2/M3 + deadline), KPI-рядок (reuse `Kpi`), growth-чарт (Recharts), builders-таблиця (engagement/retention), infra-картка (DB size vs 500MB cap, Helius ceiling, ingest lag), alerts-breakdown by rule×severity.
  ⏱ 1.5 дня · 📦 **v0.5.1-admin**
  **Файли:** `apps/dashboard/src/routes/admin.tsx` · `apps/dashboard/src/App.tsx` (route) · Layout nav (owner-gated) · `apps/dashboard/src/lib/use-is-owner.ts`

**Cluster F total:** ~3 дні, 2 micro-releases (v0.5.0-admin → v0.5.1-admin)

---

## Загальна оцінка

| Cluster | Releases | Tasks | Days | Twit moments |
|---|---|---|---|---|
| **E (Infra Hardening + Deploy-safety 🔴 PRIORITY)** | **v0.4.3 → v0.5.0-infra** | **6** | **~5** | **4** |
| A (Detection + Parsers) | v0.4.0 → v0.5.4 | 8 | ~16 | 8 |
| B (Notifications + DX) | v0.6.0 → v0.7.1 | 8 | ~11 | 8 |
| **C (Dashboard UX + Growth 🔴 C.0/C.0b priority)** | **v0.4.8 → v0.8.1** | **10** | **~14.5** | **10** |
| D (AI/LLM features) | v0.9.0 → v0.9.3 | 4 | ~12 | 4 |
| **F (Grant Ops / Admin) 🟢** | **v0.5.0-admin → v0.5.1-admin** | **2** | **~3** | **1** |
| **Total** | **34 releases** | **38 tasks** | **~61.5 days** | **35 tweet-moments** |

**Каденс:** один micro-release на тиждень при солірному vibe-coding ритмі — ~6 місяців до v0.9.3. Це не обіцянка, а ceiling.

---

## Порядок виконання — рекомендований

**Phase 0 (🔴 PRIORITY, grant-blocking infra):** E.1 → E.2 → E.3 → E.4 → E.5 *(усі виконані або [~])*
- Без E.1+E.2 грантова M3 (50 агентів) впирається у Helius getBalance-cron (~23 агенти) і тісний storage. ~4.5 днів. Деталі — [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md).

**Phase 0b (🔴 PRIORITY, onboarding + deploy-safety — пріоритизовано 2026-06-10):** E.7 → C.0 → C.0b
- **E.7** (~0.5 дня): фікс DB-hang після кожного deploy — ~30с деградація для всіх юзерів. Без цього кожен release = поганий UX для наявних builders.
- **C.0** (~2 год): activation banner на agent-detail коли `lastSeenAt == null` — закриває gap між «зареєстрував» і «побачив першу дату».
- **C.0b** (~4.5 год): public read-only demo agent — юзери бачать платформу до реєстрації, знижує бар'єр входу.

**Phase 1 (high-value, low-risk):** A.8 ✅ → B.5 ✅ → C.6 ✅ — *ЗАКРИТА (B.1 відкладено)*
- Priority fee anomaly, Prometheus metrics, README badge — всі зроблені. B.1 Discord відкладено на кінець.

**Phase 2 (parser surge):** A.4 ✅ → A.5 ✅ → A.7 ✅ → A.6
- 4 парсери підряд, ~11 днів. Раз вже у parser-зоні — не випадати в інші файлові кластери. Залишився A.6 (Drift perps) — найскладніший через market-index model.

**Phase 3 (DX + self-host):** B.7 → B.6 → B.8
- Спрямовано на self-host story для open-source momentum.

**Phase 4 (Growth surface):** C.7 → C.8
- Marketing-driven. C.7 (embeddable widget) залежить від C.0b (public read routes).

**Phase 5 (AI moat):** D.1 → D.2 → D.3 → D.4
- Найдорожчі за часом і потребують Claude API integration. Робити коли інші clusters виходять у v0.8.x.

**Залишок (B.2, B.3, B.4, C.1, C.2, C.3, C.4, C.5):** інтерліфувати між phases як "відпочинок від важких задач".

**B.1 (Discord) — в самому кінці:** робити після B.2-B.8 і решти Cluster B.

---

## Що НЕ потрапило у roadmap і чому

| Ідея | Причина відмови |
|---|---|
| Custom alert rule builder UI | Складно, ROI низький — env-config достатньо для power-users; casual users роблять 1-2 правила, дефолтів вистачає |
| ML-based anomaly detection (autoencoder, isolation forest) | Потребує мейнтейнс-важкого feature pipeline; rule-based + D.1 auto-tuning покривають >80% сигналу |
| Mobile native app (React Native) | C.2 (responsive web) дешевше і покриває use-case "глянути в дорозі" |
| SSO / RBAC / team management | Soло продукт, single-user; коли з'явиться enterprise customer — додамо ad-hoc |
| On-chain agent reputation | Поза скоупом observability tool; це окремий продукт |
| Backfill історичних tx | Stream-only — простіше підтримувати; ретроактивний parsing рідко потрібен |
| Multi-wallet agent support (1 агент = N wallets) | Поточна 1:1 модель добре працює; коли з'явиться юзер з реальним multi-wallet use-case — переглянемо |
| Custom domain (`agentscope.io`) | Зайнятий конкурент; `agentscopehq.dev` достатньо |
| iOS/Android push notifications | Telegram + email + webhooks покривають; додавати окремий FCM/APNS канал не варто складності |

---

## Лог релізів post-MVP

Ведемо у `CHANGELOG.md` (Keep-A-Changelog 1.1.0). Кожен пункт цього roadmap → один секція `[X.Y.Z] - YYYY-MM-DD`. GitHub Release tag через `gh release create vX.Y.Z`.

| Version | Date | Task | Status |
|---|---|---|---|
| v0.2.0 | 2026-05-14 | E17 (ARCHITECTURE.md + CSV export + CHANGELOG) | ✅ released |
| v0.3.0 | 2026-05-19 | E18 (per-rule alert silencing) | ✅ released |
| v0.4.0 | 2026-05-22 | A.1 (MEV sandwich detector) | ✅ released |
| v0.4.1 | 2026-05-25 | A.2 (low-balance alert) | ✅ released |
| v0.4.2 | 2026-05-29 | A.3 (runaway-loop detector) | ✅ released |
| v0.4.3 | 2026-06-01 | E.1 (getBalance → getMultipleAccounts batch) | ✅ released |
| v0.4.4 | 2026-06-03 | E.2 (rawLogs storage diet) | ✅ released |
| v0.4.6 | 2026-06-05 | E.5 (compact parsed_args._all) | ✅ released |
| v0.5.0 | 2026-06-23 | A.4 (Raydium AMM v4 + CLMM parser) | ✅ released |
| v0.6.4 | 2026-06-26 | B.5 (Prometheus /metrics endpoint) | ✅ released |
| v0.5.1 | 2026-07-01 | A.5 (Orca Whirlpools parser) | ✅ released |
| v0.5.3 | 2026-07-07 | A.7 (Marinade liquid staking parser) | 🔄 pending commit |
| … | … | … | … |

---

## Maintenance items (не roadmap, але треба тримати в голові)

- **Supabase free tier 500 MB cap** — `agent_transactions` партиціонована помісячно (RLS-enabled, P.11), а `apps/ingestion/src/partition-maintenance.ts` (2026-06) тепер **автоматично розкочує партиції вперед** (`PARTITION_MONTHS_AHEAD`, default 3) — це закрило приховану діру: initial-міграція мала партиції лише до 2026-09, тож після 1 жовтня tx падали б у DEFAULT-партицію (рівно вікно гранту M3). TTL-drop старих місяців реалізований, але **opt-in** через `TX_RETENTION_MONTHS` (default 0 = вимкнено — видалення історії tx це продуктове рішення). Увімкнути (напр. `3`), коли prod-DB наближається до ~350-400 MB. **Точна модель місткості (до скількох агентів витягне 500 MB, формули, важелі) — [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md); реалізаційні задачі — Cluster E вище.** **Neon як альтернатива відхилена (2026-06-01):** Neon free = ті самі 0.5 GB + 100 CU-hr/міс cap, ворожий до нашого 24/7-writer'а (засинання неможливе → ~182 CU-hr > 100). Наступний платний крок при перерості free = **Supabase Pro $25/mo (8 GB, без RLS-міграції)**, не Neon.
- **Helius free tier RPC limits** — Helius free = 10 RPS / 1M credits/mo. Гарячий кредитний насос = `getBlock` у slot-neighbour (A.1 sandwich). **Alchemy free — drop-in fallback** (25 RPS / 30M CU): код provider-agnostic (стандартний WS + JSON-RPC, Helius-gRPC unused), тож перехід = свап `SOLANA_RPC_URL`+`SOLANA_WS_URL`. Опція zero-cost: streaming на Helius + getBlock на Alchemy = подвоєний free-headroom. Pro ($199/mo) лише коли обидва free впруться. **УВАГА (2026-06-01): справжня поточна стеля — НЕ rate, а credits, і впирається на ~23 агентах через getBalance-cron (E.1 fix критичний). Деталі — [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md) + Cluster E.** До фіксів — стеля ~23 агенти, не «не оптимізуємо передчасно».
- **Railway free credits ($5/mo)** — поточне споживання ~$2/mo (api + ingestion sidecar). Запас до 10× users.
- **npm package versions** — `@agentscopehq/elizaos-plugin@0.1.0-alpha.0` і `@agentscopehq/agent-kit-sdk@0.1.0-alpha.0` живуть як alpha. Перший stable `1.0.0` — коли A.1-A.3 (нові правила) і B.1-B.2 (Discord/Slack) виходять, тобто десь біля v0.6.x release.
- **Prod migrations** — будь-яка нова DB migration (а у roadmap їх 5+: A.2 balance cache, B.1/B.2 channels, B.3 webhook secret, B.8 token rotation, D.3 quality score) потребує `pnpm --filter @agentscope/db db:push` на Supabase prod ПЕРЕД деплоєм нової версії api/ingestion.

---

## Як я (Claude) маю використовувати цей файл

При наступних сесіях:
1. Якщо власник просить "що далі робити?" — пропоную наступний task з рекомендованого порядку вище.
2. Якщо власник просить "напиши твіт" — використовую `🎯` поле як основу, дотримуючись `docs/MARKETING.md §12` протоколу.
3. Коли task закривається — оновлюю checkbox `[ ]` → `[x]`, додаю commit hash + date, апдейчу `Лог релізів`. Перед `/clear` — комітимо.
4. Якщо new ideas вилазять у розмові — додаю їх у відповідний Cluster з `[ ]` маркером і `⏱ TBD`, не починаю роботу до явного погодження власника.
