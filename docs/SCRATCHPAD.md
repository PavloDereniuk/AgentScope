# Scratchpad

Робочі нотатки між сесіями. Оновлювати після кожної задачі. **Перед перебоями електроенергії — checkpoint у git.**

---

## 🚦 Як відновитись після відключення світла

1. Прочитай цей файл (SCRATCHPAD.md) — він має поточний стан
2. Прочитай `docs/TASKS.md` — лічильник `Завершено: N / 99` і "Поточна:" внизу
3. `git log --oneline -10` — побачиш останні комміти, фактично закомічений стан
4. `git status` — побачиш чи є uncommitted робота (ще не затверджена користувачем)
5. Якщо є uncommitted — це продовження останньої задачі. Питай користувача чи затверджує.
6. Якщо все коміти clean — переходь до наступної задачі з TASKS.md.

---

## Поточна сесія: 2026-04-07

### Сумарно зроблено
- **Phase 1:** SPEC.md фіналізовано (`25e4b77` no, це інший — SPEC у `144da03`)
- **Phase 2:** PLAN.md + monorepo init (`144da03 chore: init project structure`)
- **Phase 3:** TASKS.md — 99 атомарних задач (`b71f35e docs: add task decomposition`)
- **Phase 4 (in progress):** Епік 1 — Foundation, 10 з 12 кодинг-задач закомічено

### Закомічено (git log)
```
dc9bd16 feat(ingestion): websocket fallback for helius free tier                 ← 1.9b + scripts + RUNTIME VALIDATED ✅
c209a10 docs: scratchpad — close epic 1 checkpoint
5a6ee81 chore: ci sanity — stub tsconfigs and placeholder scripts                ← 1.12
ba0931f feat(ingestion): persist matched transactions to db                     ← 1.11
03e2393 docs: refresh SCRATCHPAD checkpoint with current state                  ← (recovery anchor)
f7148ff feat(ingestion): worker skeleton, yellowstone client, tx subscription   ← 1.8+1.9+1.10
58c6fc4 feat(db): rls session helpers and pglite smoke tests                    ← 1.6+1.7
b12f0d9 feat(db): rls policies and partitioned transactions                     ← 1.4+1.5
737d6aa docs: add USER-SETUP.md with manual checklist                           ← user-setup
9e4d5ca chore(db): scaffold drizzle client and config                           ← 1.3
3c97cf7 feat(shared): add zod schemas with type alignment guards                ← 1.2
25e4b77 feat(shared): add core domain types                                     ← 1.1
b71f35e docs: add task decomposition (TASKS.md)                                 ← Phase 3
144da03 chore: init project structure                                           ← Phase 2
```

### ✅ NO uncommitted work — clean checkpoint, Епік 1 RUNTIME VALIDATED

### Runtime stack online
- ✅ Supabase: 5 tables + 6 partitions + RLS + policies + current_user_id() — verified via verify-supabase.ts
- ✅ Helius free WebSocket: onLogs subscription works, full pipeline tested (81 tx persisted in 5s smoke run, then truncated)
- ✅ Privy: creds у .env (runtime check у 3.3)
- ✅ Telegram bot: test ping надіслано, працює (runtime check у 5.12)
- ⏳ GitHub repo: пропущено (зробимо потім)

### Helper scripts (packages/db/scripts/)
- `verify-supabase.ts` — перевіряє state БД
- `seed-test-agent.ts` — створює test user+agent (вимагає AGENT_WALLET env)
- `reset-test-data.ts` — truncate + delete seeded data
- `count-tx.ts` — quick count(*)

### Архітектурні зміни (з 1.9b)
- **Замість Yellowstone gRPC → @solana/web3.js WebSocket** (Helius LaserStream paywalled)
- Latency: ~1-3s замість ~500ms — прийнятно для MVP
- Per-wallet `onLogs` subscriptions з reconcile loop
- `getTransaction()` follow-up для program IDs (N+1 pattern, ОК для low volume)
- `grpc-client.ts` лишається у repo для post-MVP коли LaserStream стане доступним

### Юзер setup status (USER-SETUP.md)
- ❌ 1.0a Supabase — НЕ зроблено
- ❌ 1.0b Helius — НЕ зроблено
- ❌ 1.0c Privy — НЕ зроблено
- ❌ 1.0d Telegram bot — НЕ зроблено
- ❌ 1.0e GitHub repo + push — НЕ зроблено
- **Наслідок:** runtime валідація 1.5/1.9/1.10/1.11 відкладена

### Відомі тех-borrows / TODOs
1. **`block_time = new Date()` у persist.ts** — Yellowstone tx update не має block_time напряму. У 2.11 додати `getBlockTime()` RPC fetch.
2. **`shared` package: `declaration: false`** — `brandSym` не може бути named з-за меж модуля. Якщо знадобиться published `.d.ts` (npm publish post-MVP) — refactor.
3. **`shared` package: `.js` extensions прибрано** — `moduleResolution: "Bundler"` дозволяє це. Trade-off: shared не consumable як raw Node ESM. Тільки через bundler/tsx/vitest.
4. **Partition cron не написано** — поки 6 партицій вручну (Apr-Sep 2026). Post-MVP: cron job для авто-створення.
5. **`dedupeKey` додано у alerts (поза SPEC §3)** — для cooldown'ів детектора.
6. **Helius free Yellowstone — не підтверджено** — якщо вони не дають gRPC безкоштовно, треба fallback на `connection.onSlotChange()` через WS.

### Поточна задача
**2.1** — Парсер foundation (`packages/parser` deps + types)

### Наступні задачі (черга)
- **2.1** Парсер foundation — `packages/parser` deps + types
- **2.2** Парсер public API stub
- **2.3** Jupiter v6 fixtures (5 реальних tx з devnet)
- **2.4** Kamino fixtures (5 tx)
- **2.5-2.7** TDD Jupiter parser (failing test → IDL → parser → green)
- **2.8-2.10** TDD Kamino parser
- **2.11** Інтеграція парсера у ingestion (заповнює `instruction_name` + `parsed_args`)
- **2.12** (вже частково зроблено у 1.11 client-side — server-side filter NOT applicable з WebSocket fallback)

### Прогрес: 13 / 99 (≈13%) — Епік 1 RUNTIME complete
- ✅ Епік 1 (Foundation): 12/12 + 1.9b (WS fallback) = 13 tasks committed
- ✅ Setup: Supabase + Helius + Privy + Telegram (GitHub later)
- 📦 Епік 2 (Parsers): починаємо

---

## Архітектурні рішення (швидкий референс)

| # | Рішення | Чому |
|---|---|---|
| Branding | `Brand<T,B>` через `brand.ts` з `unique symbol` | Type safety без runtime cost |
| `solDelta` | string, не number | Lamport precision (9 decimals overflow JS number) |
| ENUMs | `as const` tuples + `pgEnum` | Single source of truth shared↔db |
| Partitioning | RANGE by `block_time`, monthly, composite PK `(id, block_time)` | PG vimoga для unique constraints |
| RLS | Session var `app.user_id` (не Supabase Auth) | Privy не інтегрований з PG auth |
| Ingestion BYPASSRLS | окрема role | Worker пише за всіх агентів |
| `setRequestUserId` | тільки в транзакції | Інакше leak через pool |
| Smoke tests | PGlite (PG16 WASM), не pg-mem | Реальна PG semantics, не mock |
| Yellowstone client | first match attribution | Простіше за per-account split |
| Slot/tx subscription | один stream, об'єднаний request | Зменшує round-trips |
| ALT lookups merge | у `projectTx` | Інакше пропускаємо ~30% v0 tx |

---

## Команди для відновлення стану

```bash
# Що в робочому дереві?
git status --short
git log --oneline -10

# Чи проходять усі перевірки?
pnpm lint
pnpm typecheck
pnpm test

# Як виглядають вже зроблені тести?
pnpm --filter @agentscope/shared test
pnpm --filter @agentscope/db test

# Перегенерувати міграції (idempotent — не змінює нічого):
pnpm --filter @agentscope/db exec drizzle-kit generate

# Запустити ingestion локально (потребує .env):
pnpm --filter @agentscope/ingestion dev
```
