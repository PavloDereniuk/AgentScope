# Scratchpad

Робочі нотатки між сесіями. Оновлювати після кожного комміта. **Recovery anchor для перебоїв електроенергії.**

---

## 🚦 ЯК ВІДНОВИТИСЬ ЗАВТРА (або після відключення світла)

1. **Прочитай цей файл** — він має повний поточний стан
2. **Прочитай `docs/TASKS.md`** — лічильник `Завершено: N / 99` і "Поточна:" внизу
3. **`git status --short`** — переконайся що нічого не uncommitted
4. **`git log --oneline -15`** — побачиш фактичний прогрес у коммітах
5. **Перекажи користувачу:** «Я бачу що ти на задачі 3.1 (Hono API skeleton). Підтверджуєш — стартую?»
6. Якщо є uncommitted робота — питай чи затверджує перш ніж commit'нути
7. Якщо все clean — запитай дозвіл стартувати наступну задачу

**Не починай сам без підтвердження** — користувач може передумати, додати креди, переробити план.

---

## Стан на день 2, сесія 2026-04-08

### Поточна задача
**3.2** — `apps/api/src/middleware/error.ts` — глобальний error handler з форматом `{error:{code,message}}`. **Чекає старту**.

### Прогрес: 25 / 99 (≈25%)
- ✅ **Епік 1 (Foundation): 13/13** — RUNTIME validated на справжньому Supabase + Helius
- ✅ **Епік 2 (Parsers): 11/12** — 22 unit tests з реальними mainnet fixtures (Jupiter v6 + Kamino Lend). 2.12 = N/A для WS fallback.
- ⏳ **Епік 3 (REST API): 1/12** — Hono skeleton + `/health` online (3.1 ✅)
- 📦 Епіки 4-9: не починалися
- ⏳ Mainnet runtime валідація persist'у jupiter/kamino — у Тиждень 5 (по плану SPEC §10)

### Наступні задачі (черга з TASKS.md)
- **3.2** Error middleware ⏱ 30m
- **3.3** Privy JWT auth middleware ⏱ 60m → потребує `PRIVY_APP_SECRET` (вже в `.env`)
- **3.4** In-memory SSE bus ⏱ 30m
- **3.5-3.9** Agents CRUD endpoints (POST/GET/GET:id/PATCH/DELETE)
- **3.10-3.11** Transactions read endpoints
- **3.12** Alerts read endpoint

### Що зробили у 3.1
- `apps/api/package.json` — додано `hono@^4.6.14`, `@hono/node-server@^1.13.7`, `tsx@^4.19.2`; оновлено `dev`/`start` scripts (`tsx watch --env-file=../../.env`).
- `apps/api/src/index.ts` — мінімальний Hono app з `GET /health → {ok:true}`, `serve()` на `PORT ?? 3000`, temporary `console.log` банер (з `biome-ignore lint/suspicious/noConsoleLog`; pino lендиться у 3.2 разом з error middleware).
- Smoke test: сервер піднявся на 3000, `curl /health` → `200 {"ok":true}`.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене (14/14 turbo tasks).

---

## Закомічено (повний git log)

```
b13672a docs: scratchpad — fix progress counter
e140ca0 docs: scratchpad — close epic 2
c2e0318 feat(ingestion): integrate parser into persist pipeline      ← 2.11
bb65dbf feat(parser): kamino lend decoder for 6 lending operations    ← 2.8 + 2.10
c9b2af5 feat(parser): freeze kamino lend idl from on-chain anchor     ← 2.9
6fe32f8 docs: scratchpad — current task fix
7dc1a0a docs: scratchpad checkpoint after jupiter parser
8f8c2a8 feat(parser): jupiter v6 swap decoder with native SOL wrap    ← 2.7
9d427d0 feat(parser): freeze jupiter v6 idl from on-chain anchor      ← 2.6
a57f0ad test(parser): jupiter swap fixtures and TDD targets (skipped) ← 2.5
cbe467d test(parser): kamino lend fixtures from mainnet                ← 2.4
62c2ea2 test(parser): jupiter v6 swap fixtures from mainnet            ← 2.3
cc6ce0d feat(parser): dispatcher with sol/token delta computation      ← 2.2
a8da56e feat(parser): public types for instruction parsers             ← 2.1
8deff7e docs: scratchpad — epic 1 runtime validated, start epic 2
5a6ee81 chore: ci sanity — stub tsconfigs and placeholder scripts      ← 1.12
ba0931f feat(ingestion): persist matched transactions to db            ← 1.11
03e2393 docs: refresh SCRATCHPAD checkpoint with current state
f7148ff feat(ingestion): worker skeleton, yellowstone client, tx sub   ← 1.8+1.9+1.10
58c6fc4 feat(db): rls session helpers and pglite smoke tests           ← 1.6+1.7
b12f0d9 feat(db): rls policies and partitioned transactions            ← 1.4+1.5
737d6aa docs: add USER-SETUP.md with manual checklist                  ← user setup
9e4d5ca chore(db): scaffold drizzle client and config                  ← 1.3
3c97cf7 feat(shared): add zod schemas with type alignment guards       ← 1.2
25e4b77 feat(shared): add core domain types                            ← 1.1
b71f35e docs: add task decomposition (TASKS.md)                        ← Phase 3
144da03 chore: init project structure                                  ← Phase 2
```

### dc9bd16 окремий — feat(ingestion): websocket fallback for helius free tier ← 1.9b

---

## ✅ NO uncommitted work — clean checkpoint

Перевірено `git status` на момент завершення сесії — все committed.

---

## Runtime stack online (підтверджено вживу)

- ✅ **Supabase** Postgres (eu-west-3): 5 tables + 6 monthly partitions + RLS + 5 policies + `current_user_id()` function. Verified via `verify-supabase.ts`.
- ✅ **Helius free WebSocket**: `onLogs` per wallet + `getTransaction` hydrate pipeline. **81 tx persisted** у smoke run за 5 секунд (потім truncated).
- ✅ **Privy** App ID `cmnot576...`: creds у `.env`. Runtime check у задачі 3.3.
- ✅ **Telegram bot** `@agentscope_alerts_bot`: test ping надіслано на chat 558662392. Runtime check у задачі 5.12.
- ⏳ **GitHub repo** — пропущено за рішенням користувача, зробимо коли захоче.

---

## Тести: 34/34 зелені

```
@agentscope/shared       27 tests (zod schemas + type alignment)
@agentscope/db            7 tests (PGlite migrations + CRUD + cascade + unique)
@agentscope/parser       22 tests (9 dispatcher + 6 jupiter + 7 kamino з real mainnet fixtures)
```

Перевірка: `pnpm test` (turbo cached, ~5s).

---

## Helper scripts (не у CI, для ручної роботи)

| Скрипт | Призначення |
|---|---|
| `packages/db/scripts/verify-supabase.ts` | Перевіряє стан БД (tables, partitions, RLS, policies) |
| `packages/db/scripts/seed-test-agent.ts` | Створює test user+agent (вимагає `AGENT_WALLET` env) |
| `packages/db/scripts/reset-test-data.ts` | Truncate transactions + delete seeded user |
| `packages/db/scripts/count-tx.ts` | Quick `count(*)` |
| `packages/parser/scripts/fetch-jupiter-fixtures.ts` | Refresh Jupiter fixtures з mainnet |
| `packages/parser/scripts/fetch-kamino-fixtures.ts` | Refresh Kamino fixtures з mainnet |
| `packages/parser/scripts/fetch-jupiter-idl.ts` | Refresh Jupiter IDL з on-chain |
| `packages/parser/scripts/fetch-kamino-idl.ts` | Refresh Kamino IDL з on-chain |
| `packages/parser/scripts/inspect-fixtures.ts` | Debug: дискримінатори у jupiter fixtures |
| `packages/parser/scripts/inspect-kamino-fixtures.ts` | Debug: дискримінатори у kamino fixtures |
| `packages/parser/scripts/match-kamino-discriminators.ts` | Match disc → instruction names через sha256 |
| `packages/parser/scripts/debug-route.ts` | Debug: account+token balance walk для jupiter route |

---

## Архітектурні рішення (швидкий референс)

| # | Рішення | Чому |
|---|---|---|
| Branding | `Brand<T,B>` через `brand.ts` з `unique symbol` | Type safety без runtime cost |
| `solDelta` | decimal string, не number | Lamport precision (9 decimals overflow JS number) |
| ENUMs | `as const` tuples + `pgEnum` | Single source of truth shared↔db |
| Partitioning | RANGE by `block_time`, monthly, composite PK `(id, block_time)` | PG вимога для unique constraints |
| RLS | Session var `app.user_id` (не Supabase Auth) | Privy не інтегрований з PG auth |
| Ingestion BYPASSRLS | окрема role / service connection | Worker пише за всіх агентів |
| `setRequestUserId` | тільки в транзакції | Інакше leak через pooled connection |
| Smoke tests | PGlite (PG16 WASM), не pg-mem | Реальна PG semantics, не mock |
| Stream | WebSocket onLogs (не Yellowstone gRPC) | Helius LaserStream paywalled |
| Per-wallet subs | reconcile loop | Підтримка нових агентів без рестарту |
| `getTransaction` hydrate | N+1 fetch на free tier | Простіше, ОК для low volume |
| Jupiter parser | Manual byte decode (не BorshInstructionCoder) | route_plan vec ламає auto-decode |
| Jupiter mints | 3 strategies + native SOL wrap detection | route variant не має source_mint |
| Kamino parser | Computed sha256 discriminators (старий IDL формат) | IDL без explicit disc field |
| Kamino accounts | Recursive flatten composite groups | Anchor composite accounts pattern |
| Primary instruction | Skip refresh/init wrappers | Timeline показує meaningful op |
| `parsed_args._all` | Зберігаємо ВСІ ix у одному jsonb полі | MVP — без separate ix table |

---

## Тех-borrows / TODOs (post-MVP або у конкретних задачах)

1. **`block_time` у `persist.ts`** — поки `new Date()` (receive time). Реальний block_time тепер з parser (`parsed.blockTime`), але для grpc-client path лишається receive-time. У Тижні 5 mainnet міграції перевірити точність.
2. **`shared` package: `declaration: false`** — `brandSym` (unique symbol) не може бути named з-за меж модуля. Якщо знадобиться npm publish post-MVP — refactor brand strategy.
3. **`shared` package без `.js` extensions** — `moduleResolution: "Bundler"` дозволяє це. Trade-off: shared не consumable як raw Node ESM. Тільки через bundler/tsx/vitest.
4. **Partition cron** — поки 6 партицій вручну (Apr-Sep 2026). Post-MVP додати cron job.
5. **`dedupeKey` у alerts** — додано (поза SPEC §3) для cooldown'ів детектора. Реалізація у задачі 5.x.
6. **Kamino fetch script** має зламаний discriminator scoring (`require()` у ESM) — fixtures збережені через unclassified bucket. Якщо знадобиться різноманітніший набір — пофіксити.
7. **`pickPrimaryInstruction` heuristic** — для tx з Jupiter+Kamino одночасно показує перший. Post-MVP можна додати priority weighting.
8. **`grpc-client.ts` лишається у repo** хоч не використовується. Готовий до post-MVP коли LaserStream стане доступним.

---

## .env stan

Все що треба для Епіку 3 уже є:
- `DATABASE_URL` ✅
- `HELIUS_API_KEY` + `SOLANA_RPC_URL` ✅
- `PRIVY_APP_ID` + `PRIVY_APP_SECRET` + `VITE_PRIVY_APP_ID` ✅ (потрібно для 3.3)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DEFAULT_CHAT_ID` ✅ (потрібно для 5.12)

`.env` у `.gitignore`, секрети **НЕ комічені**.

⚠️ **Важливо:** секрети у історії чату попередньої сесії. Користувач планує ротувати після хакатону.

---

## Команди для quick check завтра

```bash
cd /c/Users/Pasha/Desktop/AgentScope

# 1. Що в робочому дереві?
git status --short
git log --oneline -10

# 2. Чи все компілюється і тести зелені?
pnpm lint           # 58 файлів, мав би бути green
pnpm typecheck      # 13 packages green
pnpm test           # 34 tests green (turbo cache hit ~5s)

# 3. Перевірити Supabase state (опційно)
# Replace DATABASE_URL з .env
DATABASE_URL="..." apps/ingestion/node_modules/.bin/tsx packages/db/scripts/verify-supabase.ts

# 4. Якщо хочеш бачити tests verbose:
pnpm --filter @agentscope/shared test
pnpm --filter @agentscope/db test
pnpm --filter @agentscope/parser test
```

---

## Перше повідомлення завтра (приклад)

> «Прочитай docs/SCRATCHPAD.md і скажи з чого продовжуємо»

Я тоді:
1. Читаю SCRATCHPAD (цей файл)
2. Перевіряю `git status` + `git log -10`
3. Запускаю `pnpm test` для перевірки що нічого не зламалось overnight
4. Кажу: «Все clean, остання задача — 2.11 (parser integration). Наступна — **3.1 Hono API skeleton**. Стартую?»
