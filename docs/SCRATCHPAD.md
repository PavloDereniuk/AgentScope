# Scratchpad

Робочі нотатки між сесіями. Оновлювати після кожного комміта. **Recovery anchor для перебоїв електроенергії.**

---

## 🚦 ЯК ВІДНОВИТИСЬ ЗАВТРА (або після відключення світла)

1. **Прочитай цей файл** — він має повний поточний стан
2. **Прочитай `docs/TASKS.md`** — лічильник `Завершено: N / 99` і "Поточна:" внизу
3. **`git status --short`** — переконайся що нічого не uncommitted
4. **`git log --oneline -20`** — побачиш фактичний прогрес у коммітах
5. **Перекажи користувачу:** «Я бачу що ти на задачі X. Підтверджуєш — стартую?»
6. Якщо є uncommitted робота — питай чи затверджує перш ніж commit'нути
7. Якщо все clean — запитай дозвіл стартувати наступну задачу

**Не починай сам без підтвердження** — користувач може передумати, додати креди, переробити план.

---

## Стан: Epic 4 in progress — DAY 4 (2026-04-09)

### Поточна задача
**Epic 6** — Dashboard (React + Vite + Tailwind + shadcn/ui + Privy + react-query).

### Прогрес: 57 / 99 (≈58%)
- ✅ **Епік 1 (Foundation): 13/13** — RUNTIME validated на справжньому Supabase + Helius
- ✅ **Епік 2 (Parsers): 11/12** — Jupiter v6 + Kamino Lend на real mainnet fixtures (2.12 = N/A для WS fallback)
- ✅ **Епік 3 (REST API): 12/12 CLOSED** — Hono + Privy auth + SSE bus + full CRUD + tx + alerts. **88 api тестів.**
- ✅ **Епік 4 (Reasoning Collector): 7/7 CLOSED** — OTLP/HTTP receiver, zod schema, agent-token auth, span persist, tx correlation, reasoning+transaction read endpoints. **31 tests.**
- ✅ **Епік 5 (Detector+Alerter): 14/14 CLOSED** — evaluator, 5 rules, detector-runner, cron, alerter+Telegram delivery. **42 tests.**
- 📦 Епіки 6-9: не починалися
- ⏳ Mainnet runtime валідація persist'у jupiter/kamino — у Тиждень 5 (по плану SPEC §10)

### 4.1 — PIVOT (2026-04-08)
Спочатку додав `@opentelemetry/otlp-transformer@0.214.0` + `@opentelemetry/api@1.9.1`. Під час перевірки імпортів виявив:
- Package публічно експортує **тільки export-side** (SDK→collector): `JsonTraceSerializer`, `ProtobufTraceSerializer`, `IExportTraceServiceResponse`
- Request types які нам реально потрібні (`IExportTraceServiceRequest`, `IResourceSpans`, `IScopeSpans`, `ISpan`, `ESpanKind`, `IKeyValue`, `IAnyValue`) існують тільки у `build/esm/trace/internal-types.d.ts`
- Deep import в internal — ризиковано при minor bumps, не public API contract
- `ESpanKind` runtime enum теж не експортується, тільки через internal path

**Рішення:** revert deps, писати свої zod-схеми в 4.2.
- OTLP/HTTP JSON це стабільний wire protocol (specs: https://opentelemetry.io/docs/specs/otlp/)
- CLAUDE.md вимагає zod на всіх API boundaries → runtime validation потрібна в любому випадку
- `z.infer<typeof otlpTraceRequestSchema>` дає TS типи — single source of truth
- Ми receiver, не OTel client — сам OTel SDK нам не потрібен взагалі

**`package.json` повернуто у попередній стан.**

### Наступні задачі (черга з TASKS.md)
- **Epic 6: Dashboard** — React + Vite + Privy auth + agents CRUD + charts + alerts

**Epic 4 гейт:** OTel SDK → receiver → persist → correlate → query flow. Коли закриємо — Epic 5 (detector + alerter).

### 4.3 — ключові файли і рішення
- **`apps/api/src/otlp/auth.ts`** — `extractAgentToken(body)` + `resolveAgentByToken(db, token)`. Token живе у **resource attribute `agent.token`** на першому `ResourceSpans` (не на span — per OTel idiom, identity belongs to Resource). Дивимось тільки першого ResourceSpans — один агент/процес/Resource. Lookup через unique index `agents_ingest_token_unique`.
- **Route flow:** schema validation → extract token → `resolveAgentByToken` → inject resolved `{agentId, userId}` у log record. Schema validation перед auth — malformed payloads не б'ють DB.
- **401 collapse:** missing attrs = empty string = unknown token → all → `401 UNAUTHORIZED` (no existence oracle, can't distinguish "no such agent" від "no token sent")
- **Чому не HTTP Authorization header?** OTel SDK ідіома — identity на Resource, не на exporter transport. Якщо процес pivots до іншого агента, він змінює Resource, не plumbing.
- **Тестовий pattern:** shared PGlite across describe block (`beforeAll`/`afterAll`) бо всі тести read-only на DB layer у 4.3. Raw drizzle insert для seed'у (bypass Privy stub). 4.4 може або лишити shared PGlite (додати per-test cleanup) або перейти на `beforeEach` isolation.

### 4.2 — ключові файли і рішення
- **`apps/api/src/otlp/schema.ts`** — zod схеми для всіх OTLP типів (ResourceSpans → ScopeSpans → Span → Event/Link/Status/KeyValue → AnyValue). Всі об'єкти `.strict()` — невідомі поля ловляться як 422. `AnyValueInput` рекурсивний type декларований вручну з `| undefined` на optional fields (через `exactOptionalPropertyTypes` strict, zod `.optional()` інферить `T | undefined`). Експортує `ExportTraceServiceRequest`, `ResourceSpans`, `ScopeSpans`, `Span`, `KeyValue`, `AnyValue`, `SpanEvent`, `SpanLink`, `SpanStatus`, `Resource`, `InstrumentationScope` через `z.infer`. Single source of truth для runtime+types.
- **`apps/api/src/routes/otlp.ts`** — `createOtlpRouter({logger})` factory. POST `/traces`, zValidator + custom 422 error handler як у решті routes. Експортує `countSpans()` helper. Повертає `{ partialSuccess: {} }` 200.
- **`apps/api/src/app.ts`** — mounted на `/v1` не під `/api/*` (OTLP spec path + без Privy auth, 4.3 додасть agent-token)
- **Types coercion:** `uint64Schema` приймає numeric string (primary) АБО JS number ≤ `Number.MAX_SAFE_INTEGER` (транслюється в string). Нано-timestamps >2^53 мають приходити як string.
- **Hex validation:** traceId `/^[0-9a-f]{32}$/`, spanId `/^[0-9a-f]{16}$/` (strict lowercase per OTLP JSON spec)
- **`kind`** = number 0..5 (SPAN_KIND enum), optional. `status.code` = 0..2, optional.

### 4.2 — тести (11 нових, 99 total api)
```
tests/otlp-traces.test.ts (11):
  accepts minimal single-span payload → 200 + partialSuccess
  logs resource/scope/span counts (capturing pino Writable stream → records[])
  empty body {} → 200
  recursive AnyValue (kvlistValue wrapping arrayValue) → 200
  startTimeUnixNano as JS number → 200 (coerces)
  invalid traceId length → 422
  non-hex spanId → 422
  span kind out of range → 422
  missing span name → 422
  non-numeric startTimeUnixNano → 422
  unknown field at span level (strict mode) → 422
```
**Оновлено у 4.3:** OTLP тести тепер на shared PGlite (seeded user+agent у beforeAll, afterAll close). Full api suite ~78-87s.

### 4.4 — ключові файли і рішення
- **`apps/api/src/otlp/persist.ts`** — `flattenAnyValue()` (рекурсивний AnyValue→JS), `flattenAttributes()` (KeyValue[]→Record), `nanoToTimestamp()` (nano string→ISO via BigInt/1_000_000n), `persistSpans()` (batch insert + onConflictDoNothing для idempotent retries).
- **Mapping Span → row:** traceId/spanId as-is (text), parentSpanId ?? null, name→spanName, nano→ISO timestamptz, attributes flatten + `otel.kind`/`otel.status_code`/`otel.status_message` як reserved keys у jsonb. txSignature залишається null (4.5).
- **Unique constraint** `(traceId, spanId)` — `onConflictDoNothing` замість upsert, бо span дані immutable після emit'у. OTel SDK retries безпечні.
- **`.returning({ id })`** замість `rowCount` — drizzle PGlite не має `rowCount`, returning дає точний count inserted rows.
- **7 тестів:** 3-span→3 rows, parentSpanId present/null, nested AnyValue→jsonb, otel metadata в attrs, nano→timestamp accuracy (BigInt division), duplicate idempotent, persisted count у log.

---

## ✅ NO uncommitted work — clean checkpoint

`git status` clean. Останні комміти:
- `fbe94d3` feat(alerter+ingestion): Telegram delivery + alert lifecycle (5.11-5.14)
- `9eeb495` feat(ingestion): periodic cron for time-based detector rules (5.10)
- `e4fbd78` feat(ingestion): detector runner — evaluate tx rules after persist (5.9)
- `c5dceb6` feat(detector): error_rate, drawdown, stale_agent cron rules (5.6-5.8)
- `b633d12` feat(detector): gas_spike rule — fee vs 24h rolling median (5.5)
- `2aed32b` feat(detector): slippage_spike rule for Jupiter swaps (5.3+5.4)
- `117518d` feat(detector): evaluateTx + evaluateCron engine with error isolation (5.2)
- `ef72bcc` feat(detector): define rule types — TxRuleDef, CronRuleDef, contexts (5.1)
- `59145b7` feat(api): return full span tree for correlated transactions (4.7)
- `184c83f` feat(api): GET /api/agents/:id/reasoning with traceId filter (4.6)
- `35dbdda` feat(api): correlate spans with solana.tx.signature attribute (4.5)
- `ebfc55d` feat(api): persist OTLP spans to reasoning_logs with idempotent upsert (4.4)
- `7a395c7` feat(api): OTLP agent-token auth via resource attribute (4.3)
- `f7af2f1` feat(api): OTLP/HTTP JSON traces receiver with zod schema (4.2)
- `95fbccd` docs(4.1): pivot to zod-first OTLP receiver — no otel deps

Git log показує фактичний прогрес — використовуй `git log --oneline -20`.

---

## Epic 3 підсумок (закрито 2026-04-08)

**Surface:**
- `/health` public
- `/api/agents` — POST (створення з ensureUser), GET (list cross-tenant isolated), GET:id (24h tx count + last alert), PATCH (partial update + immutable strip), DELETE (cascade)
- `/api/agents/:id/transactions` — keyset-paginated, opaque base64url cursor, from/to filter, max 100
- `/api/transactions/:signature` — JOIN-ownership, reasoningLogs correlated (chronological ASC)
- `/api/alerts` — global feed, filters `agentId?/severity?/from?/to?`, hard cap 100 (no cursor у MVP)

**Foundation patterns що сформувалися у цьому епіку (reusable для Epic 4+):**
- `buildApp(deps)` composition root — жодних module-level singletons, тести кидають stub deps, `server.ts` кидає реальні з `loadConfig()`
- `ensureUser(db, privyDid)` — `INSERT ... ON CONFLICT DO NOTHING RETURNING` + fallback SELECT; race-safe, викликається з кожного route що пише owner-scoped дані
- **Ownership-scoped WHERE у SQL** — або `... WHERE id = ? AND user_id = ?` для direct tables, або **INNER JOIN agents ON user_id** для дочірніх (tx, alerts). Один query, не два
- **404 no-existence-oracle** — чужі resources повертають ті ж 404 що й неіснуючі, інакше атакувальник збирає UUID'и probing'ом
- **`{error:{code,message}}` stable shape** через `registerErrorHandlers` — HTTPException → `statusToCode(status)` + original message; unknown throw → generic 500 з full stack у pino
- **`zValidator` + shared schemas** — `createAgentInputSchema`, `updateAgentInputSchema` з `@agentscope/shared` — single source of truth, frontend може перевикористати
- **PGlite integration tests** через `createTestDatabase()` helper — hermetic PG16, однакові міграції, cross-driver cast локалізований. Cost ~1.3s/test
- **Cross-tenant тест без 2-го PGlite** — другий `buildApp` з іншим verifier поверх того самого `db`. Чистий multi-user тест

**Helpers створені в Epic 3:**
- `apps/api/src/logger.ts` — pino з pino-pretty dev transport
- `apps/api/src/middleware/error.ts` — `registerErrorHandlers(app, logger)` + `statusToCode(status)`
- `apps/api/src/middleware/auth.ts` — `requireAuth(verifier, logger)` з narrow `AuthVerifier` interface
- `apps/api/src/lib/auth-verifier.ts` — `createPrivyVerifier(appId, appSecret)` factory
- `apps/api/src/lib/sse-bus.ts` — `createSseBus(logger?)` з `BusEvent` discriminated union (tx.new / alert.new), per-agentId EventEmitter isolation
- `apps/api/src/lib/users.ts` — `ensureUser(db, privyDid)`
- `apps/api/src/lib/cursor.ts` — `encodeTxCursor` / `decodeTxCursor` opaque base64url для keyset pagination
- `apps/api/src/app.ts` — `buildApp(deps)` composition root
- `apps/api/src/config.ts` — zod env loader
- `apps/api/tests/helpers/test-db.ts` — PGlite bootstrap з casting до `Database` type

**Маркер:** SSE bus створено (3.4), але ще нікуди не publish'ається. Епік 5 додасть `bus.publish({type:'alert.new'})` з детектора, Епік 6 додасть SSE route для підписки з dashboard.

---

## Runtime stack online (підтверджено вживу)

- ✅ **Supabase** Postgres (eu-west-3): 5 tables + 6 monthly partitions + RLS + 5 policies + `current_user_id()` function. Verified via `verify-supabase.ts`.
- ✅ **Helius free WebSocket**: `onLogs` per wallet + `getTransaction` hydrate pipeline. **81 tx persisted** у smoke run за 5 секунд.
- ✅ **Privy** App ID `cmnot576...`: creds у `.env`. Runtime валідація через API тести (stub verifier). **НЕ перевірено з реальним Privy JWT** — потребує dashboard для issue токенів, лишаю для Epic 6.
- ✅ **Telegram bot** `@agentscope_alerts_bot`: test ping надіслано на chat 558662392. Runtime check у задачі 5.12.
- ⏳ **GitHub repo** — пропущено за рішенням користувача, зробимо коли захоче.

---

## Тести: 217/217 зелені

```
@agentscope/shared       27 tests (zod schemas + type alignment)
@agentscope/db            7 tests (PGlite migrations + CRUD + cascade + unique)
@agentscope/parser       22 tests (9 dispatcher + 6 jupiter + 7 kamino з real mainnet fixtures)
@agentscope/detector     33 tests (7 evaluator + 9 slippage + 5 gas + 4 error-rate + 4 drawdown + 4 stale)
@agentscope/alerter       6 tests (2 format + 4 deliver router)
@agentscope/ingestion     3 tests (2 detector-runner + 1 cron cycle)
@agentscope/api         119 tests:
                          6 error middleware
                          6 auth middleware
                          7 sse bus
                          6 cursor helpers
                         44 agents CRUD + tx list (POST×6, GET×5, GET:id×7, PATCH×10, DELETE×7, tx list×9)
                          8 transactions (/api/transactions/:sig)
                         11 alerts (/api/alerts з фільтрами)
                         24 otlp traces (11 schema/validation + 4 auth + 7 persistence + 2 tx correlation)
                          7 reasoning (list, traceId filter, empty, invalid 422, cross-tenant 404, 401, txSignature)
```

**API test runtime ~78-87s**. OTLP suite використовує shared PGlite (beforeAll seed, afterAll close) — ~3s. Agents/transactions/alerts suites все ще створюють нову PGlite per-test (~1.3s/test) — можна теж мігрувати на shared pattern post-MVP, див. TODO #9.

Перевірка: `pnpm test` (turbo cached, ~5s якщо без змін; ~70s якщо api перегонявся).

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

### Epic 1-2 (foundation + parsers)
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

### Epic 3 (REST API)
| # | Рішення | Чому |
|---|---|---|
| `buildApp(deps)` | Composition root замість module singletons | Test DI без IoC container |
| Narrow `AuthVerifier` iface | Не залежимо від PrivyClient напряму | Swappable (Clerk/Auth0 post-MVP), test fakes |
| `ensureUser` upsert | INSERT … ON CONFLICT + SELECT fallback | Race-safe, first-request provisioning |
| Query-level isolation | `WHERE user_id = ?` / INNER JOIN, не RLS | BYPASSRLS role + handler-enforced; RLS = defense-in-depth |
| 404 для чужого resource | Не 403 | No existence oracle — не leak'ати UUID'и |
| `statusToCode` explicit map | Не генерується з HTTP status text | Predictable error codes як stable contract |
| Immutable fields strip | zod `.strip` default, не явна перевірка | Shared schema = single source of truth |
| Keyset pagination | `(block_time, id)` + opaque cursor | Stable під concurrent writes, O(log n) seek |
| `limit + 1` sentinel | Один query замість `COUNT + SELECT` | "has more" детекція без round-trip |
| INNER JOIN для ownership | Один query замість `SELECT tx → verify owner` | Менше round-trips, atomic у planner |
| `cast(count(*) as int)` | PG count повертає bigint → JSON string | Return `number` для frontend consistency |
| `c.body(null, 204)` | RFC 7231 No Content | Порожнє тіло для успішного DELETE |
| `reasoningLogs: []` not null | Stable shape | Frontend mapує без null guard |
| FK cascade в schema | Не ручний cleanup у handler'і | Неможливо забути child table |
| Alerts — hard cap 100, no cursor | Feed не архів | Cursor post-MVP якщо треба |

---

## Тех-borrows / TODOs (post-MVP або у конкретних задачах)

1. **`block_time` у `persist.ts`** — поки `new Date()` (receive time) для grpc-client path. Parser path уже використовує реальний `parsed.blockTime`. У Тижні 5 mainnet міграції перевірити точність.
2. **`shared` package: `declaration: false`** — `brandSym` (unique symbol) не може бути named з-за меж модуля. Якщо знадобиться npm publish post-MVP — refactor brand strategy.
3. **`shared` package без `.js` extensions** — `moduleResolution: "Bundler"` дозволяє це. Trade-off: shared не consumable як raw Node ESM. Тільки через bundler/tsx/vitest.
4. **Partition cron** — поки 6 партицій вручну (Apr-Sep 2026). Post-MVP додати cron job.
5. **`dedupeKey` у alerts** — додано (поза SPEC §3) для cooldown'ів детектора. Реалізація у задачі 5.x.
6. **Kamino fetch script** має зламаний discriminator scoring (`require()` у ESM) — fixtures збережені через unclassified bucket. Якщо знадобиться різноманітніший набір — пофіксити.
7. **`pickPrimaryInstruction` heuristic** — для tx з Jupiter+Kamino одночасно показує перший. Post-MVP можна додати priority weighting.
8. **`grpc-client.ts` лишається у repo** хоч не використовується. Готовий до post-MVP коли LaserStream стане доступним.
9. **API test runtime ~65s** — PGlite init per-test. Post-MVP: shared instance + `TRUNCATE CASCADE` у beforeEach → ~5s. Поки прийнятно (запускається рідко).
10. **Privy runtime validation** — весь Epic 3 API тестований з stub verifier, ніколи не ганяли з реальним Privy JWT. Перший real flow буде коли Epic 6 dashboard піднімемо.
11. **Alerts pagination** — MVP cap 100, no cursor. Якщо юзер має >100 alerts — додати keyset cursor за тим самим pattern'ом що у tx list.
12. **`recentTxCount` window** — 24h hard-coded. Post-MVP може стати `?window=1h|24h|7d` query param.
13. **SSE bus wiring** — bus створено у 3.4 але nowhere publishes. Epic 5 додасть `bus.publish(alert.new)` з детектора, Epic 6 додасть SSE route.
14. **Transaction signature lookup без partition pruning** — acceptable для MVP. Post-MVP: materialized view `signature → block_time` для prune.

---

## .env stan

Все що треба для Epic 4 уже є:
- `DATABASE_URL` ✅
- `HELIUS_API_KEY` + `SOLANA_RPC_URL` ✅
- `PRIVY_APP_ID` + `PRIVY_APP_SECRET` + `VITE_PRIVY_APP_ID` ✅
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DEFAULT_CHAT_ID` ✅ (потрібно для 5.12)

Epic 4 OTLP receiver не потребує нових env vars — `agents.ingest_token` для auth (у БД), OTel exporter приєднується до існуючого `POST /v1/traces` без API keys.

`.env` у `.gitignore`, секрети **НЕ комічені**.

⚠️ **Важливо:** секрети у історії чату попередньої сесії. Користувач планує ротувати після хакатону.

---

## Команди для quick check завтра

```bash
cd /c/Users/Pasha/Desktop/AgentScope

# 1. Що в робочому дереві?
git status --short
git log --oneline -20

# 2. Чи все компілюється і тести зелені?
pnpm lint           # 100 файлів, green
pnpm typecheck      # 14 tasks green
pnpm test           # 144 tests green (turbo cache ~5s; fresh ~70s)

# 3. Перевірити Supabase state (опційно)
DATABASE_URL="..." apps/ingestion/node_modules/.bin/tsx packages/db/scripts/verify-supabase.ts

# 4. API smoke test (якщо хочеш поганяти сервер)
pnpm --filter @agentscope/api dev     # tsx watch — port 3000
curl http://localhost:3000/health      # → {"ok":true}
# /api/* routes потребують Privy JWT у Authorization header
```

---

## Перше повідомлення завтра (приклад)

> «Прочитай docs/SCRATCHPAD.md і скажи з чого продовжуємо»

Я тоді:
1. Читаю SCRATCHPAD (цей файл)
2. Перевіряю `git status --short` + `git log --oneline -20`
3. Запускаю `pnpm test` для перевірки що нічого не зламалось overnight
4. Читаю `packages/db/src/schema.ts` (reasoning_logs секція) — передумова для 4.4
5. Кажу: «Все clean, Epic 4: 3/7 (39/99 total). Наступна — **4.4 persist spans → reasoning_logs**. Перед кодом покажу mapping Span→row на основі schema. Стартую?»
