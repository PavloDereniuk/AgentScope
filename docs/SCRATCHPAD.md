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
**4.1** — `apps/api`: deps `@opentelemetry/proto-grpc`, типи OTLP. **Epic 3 closed, починаємо Epic 4 (Reasoning Collector)**.

### Прогрес: 36 / 99 (≈36%)
- ✅ **Епік 1 (Foundation): 13/13** — RUNTIME validated на справжньому Supabase + Helius
- ✅ **Епік 2 (Parsers): 11/12** — 22 unit tests з реальними mainnet fixtures (Jupiter v6 + Kamino Lend). 2.12 = N/A для WS fallback.
- ✅ **Епік 3 (REST API): 12/12 CLOSED** — Hono skeleton, error middleware, Privy auth, SSE bus, full agents CRUD, tx list (paginated), tx detail with reasoning join, alerts feed with filters. 88 api тестів.
- 📦 **Епік 4 (Reasoning Collector):** наступний
- 📦 Епіки 5-9: не починалися
- ⏳ Mainnet runtime валідація persist'у jupiter/kamino — у Тиждень 5 (по плану SPEC §10)

### Наступні задачі (черга з TASKS.md)
- **4.1** OTLP deps (@opentelemetry/proto-grpc, types) ⏱ 30m
- **4.2** POST /v1/traces — OTLP/HTTP JSON receiver ⏱ 90m
- **4.3** Auth для OTLP: span attribute `agent.token` → lookup у `agents.ingest_token` ⏱ 45m
- **4.4** Persist: spans → `reasoning_logs` ⏱ 60m
- **4.5** Кореляція з `solana.tx.signature` ⏱ 20m
- **4.6** GET /api/agents/:id/reasoning ⏱ 30m
- **4.7** Оновити GET /api/transactions/:signature з full span tree ⏱ 30m

⚠️ **API test runtime = ~65s** (44 agents тестів × ~1.3s PGlite init). Post-MVP оптимізація: shared PGlite instance per-file + `TRUNCATE CASCADE` у `beforeEach` замість `createTestDatabase`. Потенційно ~5s замість 65s.

ℹ️ **Виправлення лічильника тестів** — попередній баланс (88 у 3.9) був неправильний, я пропустив parser'и у підрахунку api. Фактично після 3.9 було 110 тестів. Починаючи з 3.10 показую коректний total.

### Що зробили у 3.1
- `apps/api/package.json` — додано `hono@^4.6.14`, `@hono/node-server@^1.13.7`, `tsx@^4.19.2`; оновлено `dev`/`start` scripts.
- `apps/api/src/index.ts` — мінімальний Hono app з `GET /health → {ok:true}`.
- Smoke test: сервер піднявся на 3000, `curl /health` → `200 {"ok":true}`.

### Що зробили у 3.2
- `apps/api/src/logger.ts` — pino + pino-pretty dev transport (name: `agentscope-api`), копія патерну з `apps/ingestion/src/logger.ts`.
- `apps/api/src/middleware/error.ts` — `registerErrorHandlers(app, logger)` з `onError` + `notFound`:
  - `HTTPException` → `{error:{code: statusToCode(status), message: err.message}}`, оригінальний статус збережено.
  - Невідомий throw → 500 `{error:{code:'INTERNAL_ERROR',message:'Internal server error'}}`, повний stack logged, деталі не витікають клієнту.
  - Unknown route → 404 `NOT_FOUND` з path+method у повідомленні.
  - `statusToCode`: explicit map (400/401/403/404/409/422/429) + fallback `BAD_REQUEST` для решти 4xx, `INTERNAL_ERROR` для інших.
- **Decision:** `src/index.ts` тепер експортує лише `app` (без side effects); `serve()` винесено у окремий `src/server.ts`. Це дозволяє тестам імпортувати `app.request(...)` без port bind. `dev`/`start` scripts → `src/server.ts`.
- `apps/api/vitest.config.ts` + `apps/api/tests/error.test.ts` — 6 тестів: `/health` OK, throw→500 з guard на leak, 401/409 HTTPException з оригінальним message, 418 fallback до `BAD_REQUEST`, 404 NOT_FOUND. `silentLogger` у тестах щоб не засмічувати вивід.
- Runtime smoke (production mode, `NODE_ENV=production pnpm exec tsx src/server.ts`): pino JSON log `agentscope-api listening`, `/health` → `200 {"ok":true}`, `/nope` → `404 {"error":{"code":"NOT_FOUND","message":"Route not found: GET /nope"}}`.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. 40 tests total (27 shared + 7 db + 22 parser + 6 api).

### Ключові рішення 3.2
- **Error format `{error:{code,message}}`** — стабільний public contract. HTTPException передає оригінальне повідомлення клієнту (бо це business error), unknown throw — генерик 500 (щоб не витекли внутрішні деталі). Всі 500 логуються з повним stack.
- **index.ts без side effects** — тести ганяють `app.request()` без port bind. Bonus: якщо колись треба кілька entry points (api+worker в одному процесі), вже готово.
- **`statusToCode` явний мап** — щоб code було predictable для клієнта (stable contract), не генерується з HTTP status text.

### Що зробили у 3.3
- `@privy-io/server-auth@^1.32.5` додано як dependency у `apps/api`.
- `apps/api/src/lib/auth-verifier.ts` — narrow interface `AuthVerifier { verify(token): Promise<{userId}> }` + factory `createPrivyVerifier(appId, appSecret)` яка обгортає `PrivyClient.verifyAuthToken`. DI дозволяє тестам ганяти fake verifier без мережі/Privy.
- `apps/api/src/middleware/auth.ts` — `requireAuth(verifier, logger)` factory: читає `Authorization: Bearer <token>` header (case-insensitive regex `/^Bearer\s+(\S+)\s*$/i`), викликає verifier, `c.set('userId', ...)`, будь-яка помилка → `HTTPException(401)` зі стабільним повідомленням. Експортує `ApiEnv` тип для типизованих `c.get('userId')`.
- `apps/api/tests/auth.test.ts` — 6 тестів з fake verifier: no header, malformed scheme, verifier reject, valid → 200+userId, case-insensitive bearer, leak-guard на verifier error.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. 46 tests total (40 + 6 auth).
- `server.ts` **поки не чіпав** — auth middleware ще не wired в жоден route, це буде у 3.5 (agents CRUD: там повернемо `buildApp(deps)` factory або створимо singleton у server.ts).

### Ключові рішення 3.3
- **Factory pattern `requireAuth(verifier, logger)`** замість module-level singleton Privy client. Мотивація: тести не потребують env vars / мережі / реального JWT; верифікатор — звичайна DI залежність.
- **Narrow `AuthVerifier` інтерфейс** — middleware залежить тільки від `{verify(token)}`, а не від всього `PrivyClient`. Якщо post-MVP захочемо підтримати альтернативних провайдерів (Clerk, Auth0) — міняти одну реалізацію, middleware без змін.
- **Invalid token → `debug` log рівень, не `error`** — прострочені токени це routine (user reload, stale frontend), не ops-incident. Real errors (5xx з Privy API) підуть вище: через catch → HTTPException(401) → onError logs це як `warn` з `http exception`.
- **Не зачіпав wiring у `index.ts`/`server.ts`** — middleware це бібліотека для 3.5+. Інакше треба було б піднімати Privy client у `index.ts` зі всіма side effects, чого ми свідомо уникаємо.

### Що зробили у 3.4
- `apps/api/src/lib/sse-bus.ts` — `createSseBus(logger?)` повертає `SseBus` інтерфейс з `subscribe(agentId, handler) → unsubscribe`, `publish(event)`, `subscriberCount(agentId)`. Внутрішньо — `node:events.EventEmitter` з per-agentId event names, `setMaxListeners(0)` щоб не було warn при багатьох SSE connection'ах.
- Типи: `BusEvent` — discriminated union `tx.new` (signature, at) і `alert.new` (alertId, severity, at). Це мінімум для MVP; розширювати тут коли з'являться нові тригери.
- Isolation: кожен handler обгорнутий у `try/catch`, crash одного не впливає на інших; логується опційно через переданий logger. Якщо logger не переданий — silent swallow.
- `apps/api/tests/sse-bus.test.ts` — 7 тестів: delivery, agentId isolation, fan-out, unsubscribe, crash isolation with custom pino stream, publish-without-subscribers no-op, subscriberCount.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. 53 tests total (46 + 7 sse-bus).

### Ключові рішення 3.4
- **Per-agentId EventEmitter name** — природна ізоляція без додаткового Map<agentId, Set<handler>>, плюс O(1) dispatch. Недолік: agentId як довільний string — колізії з внутрішніми EventEmitter івентами неможливі (ми ніколи не emit'ить event name типу `newListener`), тому безпечно.
- **Publish синхронний** — EventEmitter.emit sync, handler'и теж sync (SSE writes async не чекає нічого корисного). Якщо handler чекає на щось async — це його проблема, bus не буде чекати.
- **`logger?: Logger`** optional — тести без шуму можуть не передавати; production передає pino. Alternative був би no-op logger default, але optional чистіше.
- **Post-MVP scalability explicit в коментарях** — swap `EventEmitter` на Redis pub/sub коли буде 2+ api instance, public interface лишається. Consumers mustn't import from `node:events` напряму.

### Що зробили у 3.5 (велика задача — композиційний корінь)
Додано купу foundation разом з POST /api/agents, бо без них integration test не злетів би:
- **Нові deps у `apps/api`:** `@agentscope/db@workspace:^`, `@agentscope/shared@workspace:^`, `drizzle-orm@^0.36.4`, `zod@^3.23.8`, `@hono/zod-validator@^0.7.6`, dev: `@electric-sql/pglite@^0.2.13`.
- `apps/api/src/config.ts` — zod-validated env loader (DATABASE_URL, PRIVY_APP_ID, PRIVY_APP_SECRET, PORT, NODE_ENV, LOG_LEVEL). Копія патерну з ingestion.
- `apps/api/src/app.ts` — **`buildApp(deps)` factory**, композиційний корінь. Бере `{db, verifier, sseBus, logger?}`, монтує error handlers → `/health` → `/api/*` (з requireAuth) → `/api/agents` router. Усунено module-level state.
- `apps/api/src/index.ts` — тепер просто `export { buildApp, type AppDeps }` + `ApiEnv`. Жодних side effects.
- `apps/api/src/server.ts` — оновлено, калить `loadConfig()` → `createDb()` → `createPrivyVerifier()` → `createSseBus(logger)` → `buildApp({...})` → `serve()`. Це єдине місце де читаються env vars.
- `apps/api/src/lib/users.ts` — `ensureUser(db, privyDid)`: `INSERT ... ON CONFLICT (privy_did) DO NOTHING RETURNING` + fallback SELECT. Ідемпотентний, race-safe.
- `apps/api/src/routes/agents.ts` — `createAgentsRouter(db)` з `POST /`:
  - Використовує `createAgentInputSchema` з `@agentscope/shared` (не дублюємо zod схему).
  - Custom zValidator error hook → `HTTPException(422)` з конкатенованими issue paths.
  - `userId` з `c.var` (Privy DID) → `ensureUser` → реальний `users.id` UUID для insert.
  - `generateIngestToken()`: `tok_${randomBytes(24).toString('base64url')}` — 192 bits entropy, URL-safe.
  - Insert через drizzle → `returning()` → `201 { agent }`.
- `apps/api/tests/helpers/test-db.ts` — `createTestDatabase()` стартує PGlite, автоматично завантажує всі міграції з `packages/db/src/migrations/` (по патерну з `packages/db/tests/smoke.test.ts`), **кастить pglite drizzle → `Database` тип** (driver types відрізняються, runtime query-builder surface однакова, каст свідомий і локалізований у helper).
- `apps/api/tests/agents.test.ts` — **6 integration тестів** через реальний PGlite + full buildApp pipeline:
  1. Без auth → 401
  2. З auth → 201, agent створений, **`user_id` з token** (верифіковано SELECT users WHERE privy_did → id, порівняння)
  3. Invalid body → 422 з validation message
  4. Invalid walletPubkey (non-base58) → 422
  5. Два агенти → тільки 1 user row (`ensureUser` reuse)
  6. Кожен agent має унікальний `ingestToken`
- `apps/api/tests/error.test.ts` — рефакторено: замість `import { app as realApp }` тепер `makeRealApp()` яка викликає `buildApp({ stubDb, stubVerifier, silentLogger, sseBus })`. Ті 2 тести що використовували realApp (/health, 404) — тепер через stub-deps buildApp.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **59 tests** total, 25 у api (додалось 6 agents integration), повна PGlite ініціалізація додає ~8s до api test run (кожен тест створює свою instance з міграціями).

### Ключові рішення 3.5
- **`buildApp(deps)` factory pattern** — композиційний корінь. Жодних module-level singletons ні для db, ні для Privy client, ні для sseBus. Тести можуть ганяти кілька різних конфігурацій паралельно, production має одну гілку wiring у `server.ts`. Це **найчистіший варіант DI без IoC container'а**.
- **PGlite для integration тестів** (варіант 1 з пропозиції) — hermetic, offline, real PG16 semantics, **однакові міграції як у production**. Cost: ~1.2s/test. Альтернативи: мок-драйвер (крихко), testcontainers (потребує Docker, повільно). Для MVP PGlite — правильний вибір.
- **Caст `drizzle(pg) as unknown as Database`** у test helper — свідоме порушення типів, бо pglite drizzle і postgres-js drizzle мають однаковий runtime surface, але різні TS брендові типи. Каст локалізований в одному файлі, коментарями задокументовано.
- **`ensureUser` через upsert** — fallback SELECT для race safety. Перший запит від юзера створює row, паралельні запити не ламаються на конфлікті.
- **`createAgentInputSchema` з shared**, не локальний — єдине джерело правди для форми input'у. Якщо frontend колись використовуватиме цю ж схему для валідації, не треба синхронізувати.
- **`ingest_token` генерується сервером** — клієнт не може його вказати. 192 bits, base64url, `tok_` prefix для читабельності у логах. Post-MVP може треба буде реgенерувати за кнопкою — handler на PATCH розглянемо у 3.8.
- **RLS обхід** — `api` підключається до DB з роллю що BYPASSRLS (так само як ingestion), і запити enforce'ять `WHERE user_id = :userId` на рівні handler'а. RLS policies лишаються як defense-in-depth. У PGlite тестах default role теж має superuser → RLS неефективний, що нам підходить.
- **`HTTPException(422)` для zod fails** замість default `zValidator` відповіді — уніфікує формат з нашим error middleware. Issue paths конкатенуються у message через `;`.

### Що зробили у 3.6
- `apps/api/src/routes/agents.ts` — доданий `GET /` handler: `ensureUser → SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC` через `drizzle-orm` `desc()`. Імпортовано `desc, eq` з `drizzle-orm`.
- `apps/api/tests/agents.test.ts` — нова describe `GET /api/agents` з 5 тестами:
  1. Без auth → 401
  2. Порожній список (нема агентів) → 200 `{agents: []}`
  3. 2 seeded агенти → response містить 2
  4. Ordering: newest first (створено 2 з setTimeout паузою 10ms для розділення `created_at`)
  5. **Cross-tenant isolation**: Alice seed → Bob через другий `buildApp` з іншим verifier → Bob бачить `[]`, Alice все ще бачить свій.
- Тест #5 важливий — явно перевіряє, що `WHERE user_id = :userId` у запиті ізолює tenants. Build'имо другий app instance з тим самим db але іншим verifier'ом — демонструє multi-user поведінку без необхідності два окремих PGlite.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. 64 tests total. API test runtime зросло з ~10s до ~28s через PGlite init на кожен тест × 11 agents тестів.

### Ключові рішення 3.6
- **Query-level enforcement `WHERE user_id = :userId`** — основна ізоляція tenants, не покладаємось на RLS (бо api + PGlite role = superuser/BYPASSRLS). Доповнення до `ensureUser`: кожен запит знаходить реальний users.id через DID.
- **`orderBy(desc(agents.createdAt))`** — стабільний контракт "newest first". Клієнт може розраховувати, щоб мати predictable UI без додаткової сортировки.
- **PGlite per-test cost** (~1.5s × 11) помічено. Post-MVP оптимізація: shared PGlite instance per file + `TRUNCATE CASCADE` між it'ами у `beforeEach`. Поки що 28s test run прийнятний, бо запускається рідко (pre-commit + CI).
- **Cross-tenant тест без другого PGlite** — ключове усвідомлення: двоє різних verifiers → двоє різних `buildApp` instances поверх того самого `db`, і кожен бачить тільки свої рядки через query-level фільтр. Чисто, швидко, без double setup.

### Що зробили у 3.7
- `apps/api/src/routes/agents.ts` — доданий `GET /:id` handler:
  - `zValidator('param', z.object({id: z.string().uuid()}))` → 422 якщо id не UUID
  - `SELECT * FROM agents WHERE id = ? AND user_id = ?` → 404 якщо не знайдено (не 403, щоб не витік факт існування)
  - `SELECT count(*) FROM agent_transactions WHERE agent_id = ? AND block_time >= now() - 24h` — віконний count
  - `SELECT * FROM alerts WHERE agent_id = ? ORDER BY triggered_at DESC LIMIT 1`
  - Response: `{agent, recentTxCount, lastAlert: lastAlert ?? null}`
- `RECENT_TX_WINDOW_MS = 24h` константа, прокоментовано у коді ("standard dashboard default, короткий достатньо щоб stuck/idle агент був помітним").
- Імпорти розширено: `agentTransactions, alerts, and, gte, sql, z`.
- `apps/api/tests/agents.test.ts` — нова describe `GET /api/agents/:id` з 7 тестами:
  1. Без auth → 401
  2. Non-uuid id → 422
  3. Unknown uuid → 404
  4. **Чужий агент → 404** (не 403, existence oracle prevention)
  5. Fresh agent → zero tx count + null lastAlert
  6. 3 tx inside 24h + 1 tx 48h тому → count = 3 (віконний фільтр)
  7. 2 seeded alerts → lastAlert = найновіший (gas_spike, critical)
- Тест #6 явно вставляє рядки у `agent_transactions` з різними `block_time` відносно `Date.now()`. Partition 2026_04 покриває поточну дату (2026-04-08), PGlite з нього приймає вставку.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. 71 tests total (+7). API test runtime ~28s (18 agents тестів × ~1.4s PGlite init).

### Ключові рішення 3.7
- **404 замість 403 для чужого агента** — security best practice (existence oracle prevention). Route не розрізняє "not found" і "not yours", бо інакше атакувальник може probing'ом зібрати список чужих UUID'ів. Коментар у route пояснює.
- **`zValidator('param', ...)`** для UUID валідації — без нього PG кидає `invalid input syntax for type uuid` → 500, що витікає implementation detail. Zod → 422 з нашим стандартним форматом.
- **24h window hard-coded** — post-MVP може стати query param (`?window=1h|24h|7d`), але для MVP dashboard один default вистачає. PLAN не уточнює цього.
- **`cast(count(*) as int)` у sql template** — PG `count(*)` повертає `bigint` → JSON серіалізує як string у JSON (node-postgres, postgres.js behaviour). `cast(... as int)` → `number` у JSON, що консистентно з frontend очікуваннями. 24h window навіть з багатьма агентами не перевищить 2^31.
- **`lastAlert: lastAlert ?? null`** замість `undefined` — явний `null` у JSON зрозуміліший і зберігає присутність поля у response shape.
- **Response camelCase** (`recentTxCount`, `lastAlert`) — консистентно з рештою endpoints, ігнорується snake_case у PLAN як historic doc convention.
- **Тест з block_time у quantum partition 2026_04** — працює бо Date.now() у тесті = 2026-04-08 (current date для цього проекту). Якщо колись тести тікатимуть у май без оновлення партицій — треба або додати cron для partition rotation, або cast block_time на фіксовану дату.

### Що зробили у 3.8
- `apps/api/src/routes/agents.ts` — доданий `PATCH /:id` handler:
  - `zValidator('param', uuid)` → 422 для non-uuid
  - `zValidator('json', updateAgentInputSchema)` (з `@agentscope/shared`, вже існує як `.partial()`)
  - Build SET clause тільки з полів що були у request body (не з відсутніх) — через серію `if (body.name !== undefined)` guard'ів
  - **Empty body → no-op**: фетчимо поточний row і повертаємо без UPDATE
  - Ownership-scoped `UPDATE WHERE id = ? AND user_id = ?` → `.returning()` → 404 якщо нічого
  - Імпорт `updateAgentInputSchema` додано у рядку 18
- `apps/api/tests/agents.test.ts` — нова describe `PATCH /api/agents/:id` з 10 тестами:
  1. Без auth → 401
  2. Non-uuid id → 422
  3. Unknown uuid → 404
  4. **Чужий агент → 404 + db unchanged** (existence oracle + row untouched у бд)
  5. Update single field (name) → tags untouched, db row updated
  6. Update multiple fields (tags, webhookUrl, alertRules) → all persisted
  7. `webhookUrl: null` очищує існуючий URL (перевіряємо що nullable працює)
  8. **Immutable fields silently stripped** — спроба змінити `framework`, `walletPubkey`, `ingestToken` → всі незмінні, тільки `name` оновлено (zod .strip behaviour)
  9. **Empty body `{}` → 200 + current row** (idempotent no-op)
  10. Invalid webhookUrl (not URL) → 422
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **81 tests total** (+10). API test runtime ~47s (28 agents тестів × ~1.4s).

### Ключові рішення 3.8
- **Explicit `if (body.xxx !== undefined)` замість spread** — не міг використати `{...body}` бо треба було перетворити `readonly tags` на mutable array (`[...body.tags]`). А ще треба було явно розрізняти "field absent" від "field present with undefined value" — explicit guards роблять намір прозорим.
- **Empty body → no-op, не 422** — приймаємо, щоб клієнт міг slapl'ити PATCH з "unchanged" formState і не отримав помилку. Симетрично з REST конвенціями (idempotent). Альтернатива — 400/422, але тоді клієнт має deduplicat'ити на своєму боці.
- **Skip UPDATE якщо patch = {}** — не викликаю `db.update().set({})`, бо це би кинуло drizzle error "no values". Замість того — SELECT current і return.
- **Immutable fields через zod .strip (default)** — не треба явно валідувати "нема framework/walletPubkey у body", бо `updateAgentInputSchema` не включає цих полів, і zod .strip (default) їх просто видаляє. Елегантно — single source of truth у shared.
- **`webhookUrl: null` дозволено** — `z.string().url().nullable()` у shared schema. Клієнт може очистити webhook через явний null. Порожній string НЕ дозволений (треба null).
- **`tags: [...body.tags]` spread** — body.tags типизовано як `readonly string[]` з zod schema, drizzle очікує mutable `string[]`. Spread робить shallow copy.

### Що зробили у 3.9
- `apps/api/src/routes/agents.ts` — доданий `DELETE /:id` handler: ownership-scoped `DELETE ... RETURNING id` → `c.body(null, 204)` або `HTTPException(404)`. Один і той же 404 семантика як у GET:id/PATCH (no existence oracle). Каскад на children вже є у schema.ts (`onDelete: 'cascade'` на `agentTransactions`, `reasoningLogs`, `alerts`).
- `apps/api/tests/agents.test.ts` — нова describe `DELETE /api/agents/:id` з 7 тестами:
  1. Без auth → 401
  2. Non-uuid id → 422
  3. Unknown uuid → 404
  4. Чужий agent → 404 + **row intact у db** (Alice's row unchanged)
  5. Successful delete → 204 з порожнім body, SELECT підтверджує row gone
  6. **Cascade до children** — seed agent + tx + reasoning + alert → DELETE → всі 3 child таблиці empty по agent_id
  7. Two agents for same user, DELETE one → other survives
- Імпорт `reasoningLogs` додано до тестового файлу.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **88 tests total** (+7). API test runtime ~45s (35 agents тестів × ~1.3s).

### Ключові рішення 3.9
- **FK `onDelete: 'cascade'`** (schema-level) — жодного ручного cleanup у handler'і. Drizzle schema + PG-native cascade → atomic deletion, неможливо забути child table. Якщо post-MVP додасться нова table з FK на agents — CASCADE має бути в декларації, тоді тест 6 все ще проходитиме без змін у route.
- **`c.body(null, 204)`** замість `c.json(...)` — 204 No Content по RFC 7231 повинен мати порожнє тіло. Hono-style: `body(null, status)`. Тест 5 явно перевіряє що body порожній.
- **`.returning({ id: agents.id })`** для детекції "чи видалено" — дешевше ніж окремий SELECT перед DELETE (race-free). Якщо `deleted.length === 0` → або не знайдено, або чуже, або взагалі нема → 404.
- **Тест 7 (ізоляція між своїми агентами)** — паранойдальний, але дешевий: переконуємось що WHERE не пропускає зайві рядки. Добре як регрес-тест.

## 🎉 Гейт Кінець Agents CRUD: ✅
Agents resource повністю готовий (POST/GET/GET:id/PATCH/DELETE). Залишилось по Епіку 3: transactions read (3.10-3.11) + alerts read (3.12), і гейт Епіку 3 закритий.

### Що зробили у 3.10
- `apps/api/src/lib/cursor.ts` — opaque cursor helpers:
  - `encodeTxCursor(blockTime: string, id: number) → string` (base64url JSON)
  - `decodeTxCursor(cursor: string) → TxCursor | null` з повним валідаційним guard (non-base64 → null, non-json → null, wrong shape → null, non-finite number → null)
  - Доки detailed comment: keyset vs offset pagination, stability під concurrent writes, constant-cost seek.
- `apps/api/tests/cursor.test.ts` — **6 unit тестів** для cursor: round-trip, url-safe charset, garbage input, non-json, missing fields, non-number `i`.
- `apps/api/src/routes/agents.ts`:
  - `MAX_TX_PAGE_LIMIT = 100` + `DEFAULT_TX_PAGE_LIMIT = 50`
  - `txListQuerySchema` з zod: `cursor?`, `limit` (coerce, default 50, max 100), `from?`/`to?` (datetime з offset), `.refine(from ≤ to)`
  - `GET /:id/transactions` handler:
    1. Param + query validation → 422
    2. Ownership check через SELECT agents WHERE id AND user_id → 404
    3. Build WHERE: `eq(agent_id)` + optional `gte(blockTime, from)` + optional `lte(blockTime, to)` + optional cursor condition
    4. **Cursor condition:** `or(lt(blockTime, t), and(eq(blockTime, t), lt(id, i)))` — expanded з tuple comparison для drizzle readability
    5. ORDER BY `blockTime DESC, id DESC` (stable tie-breaker)
    6. `LIMIT limit+1` як "has more" sentinel, trim, compute next cursor з last kept row
  - Response: `{transactions: Row[], nextCursor: string | null}`
- `apps/api/tests/agents.test.ts` — нова describe `GET /api/agents/:id/transactions` з **9 тестами**:
  1. No auth → 401
  2. Non-uuid id → 422
  3. Limit > 100 → 422
  4. Malformed cursor → 422
  5. Чужий agent → 404
  6. Empty tx → `{transactions:[], nextCursor: null}`
  7. 5 tx → DESC ordering, `nextCursor: null`
  8. **150 tx з limit=100**: page 1 = 100 rows + valid cursor, page 2 = 50 rows + null cursor (суворі assertions на signatures через reversed expected order)
  9. From/to window filter: 10 hourly tx, window 03:00–06:00 → 4 tx
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **125 tests total** (+15 на 3.10: 6 cursor + 9 transactions list).

### Ключові рішення 3.10
- **Keyset pagination (block_time, id) замість OFFSET** — stable під concurrent writes (новий tx що landuiться не зміщує page 2), constant cost (O(log n) seek через composite index `tx_agent_time_idx (agent_id, block_time)`), не треба міняти при rotating partition'ах.
- **Opaque base64url cursor** — клієнт не знає структуру, жодних client-side hacks типу "а давайте додамо ще фільтр до cursor". Якщо колись треба буде змінити cursor shape — invalidate старі через magic byte/version prefix, public API не ламається.
- **Decode failure → 422 не 400** — щоб уніфікувати з іншими schema validation errors. 400 використовуємо для runtime errors (missing fields у internal state), 422 для user-provided data shape issues.
- **`limit + 1` fetch як "has more" sentinel** — одна query, не треба `COUNT(*)` або окремий pre-check. Тривіальне overhead (+1 row) замість додаткового round-trip.
- **Tuple comparison expanded у `or/and/eq/lt`** — drizzle не має native row constructor comparison без raw SQL. Expansion більш verbose, але: (a) читабельна, (b) type-checked, (c) дозволяє зберегти parameterization.
- **`from`/`to` як ISO string з offset (Z або +NN:NN)** — через `.datetime({offset: true})` у zod. API користувачі не повинні здогадуватись чи фактично offset required.
- **Cursor encoded position, не filter state** — cursor зберігає тільки `(t, i)`. Time window filters (from/to) клієнт пересилає на кожен запит. Простіше, менше шансів на bug коли filters "прилипають" до старого cursor.
- **Default limit 50** (не 100) — типова dashboard table fits 50 rows, менший JSON payload, швидше rendering. Якщо клієнту треба max — явно вказує `?limit=100`.
- **Окремий `cursor.test.ts`** замість inline unit-тестів у agents.test.ts — helper'и як окремий юніт, не потребує PGlite, швидко (6 ms замість 1.3s). Integration тести залишаються для full-pipeline coverage.

### Що зробили у 3.11
- `apps/api/src/routes/transactions.ts` — новий top-level router `createTransactionsRouter(db)`:
  - `GET /:signature` з local `signatureParamSchema` (min 64, max 88, base58 regex)
  - **Ownership через INNER JOIN** `agent_transactions` ↔ `agents` з `WHERE agents.user_id = user.id` — один query, а не окремий SELECT + перевірка
  - SELECT `reasoning_logs` WHERE `tx_signature = :sig` ORDER BY `start_time ASC` (chronological для timeline)
  - Response: `{transaction, reasoningLogs}` — масив завжди є, може бути `[]` але ніколи не `null`
  - 404 на not-found або foreign agent (same no-existence-oracle policy)
  - Doc comment про partition pruning: `tx_signature` lookup не pruneable (не partition key), але `tx_signature_idx` propagate'ється до всіх child partitions → fast index lookup across all partitions. Acceptable для MVP volumes.
- `apps/api/src/app.ts` — зареєстровано `createTransactionsRouter(deps.db)` на `/api/transactions`. Routes обидва сидять під `requireAuth` middleware.
- `apps/api/tests/transactions.test.ts` — новий файл з **8 integration тестами**:
  1. No auth → 401
  2. Non-base58 signature → 422
  3. Too short signature → 422
  4. Unknown signature → 404
  5. **Чужий tx → 404 + row intact** (seeded Alice, Bob робить request через різний verifier → 404, а потім SELECT показує що row ще там)
  6. Existing tx без reasoning → `{transaction, reasoningLogs: []}` (empty array, НЕ null)
  7. **Correlated reasoning logs ordered ASC** — 3 correlated spans (insert'ені out of order) + 1 uncorrelated → response має тільки 3 у правильному хронологічному порядку
  8. Distinguish by signature — seed 2 tx, fetch по обидвох окремо, verify signature/blockTime розрізняються
- Використовую реальні mainnet-shape signatures (~88 base58 chars) як test constants.
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **133 tests total** (+8).

### Ключові рішення 3.11
- **INNER JOIN для ownership** — замість двох queries (`SELECT tx → SELECT agent → verify owner`) один JOIN. Менше round-trips, менше шансів на race, ownership enforced у SQL planner.
- **Окремий `src/routes/transactions.ts` файл** — PLAN §API має обидва `/api/agents/:id/transactions` (agent-scoped, у `agents.ts`) і `/api/transactions/:signature` (top-level). Логічно розділено по prefix. Коли додасться `/api/transactions/:signature/refresh` чи щось — сидітиме у тому самому файлі.
- **Local `signatureParamSchema`** замість `solanaSignatureSchema` з `@agentscope/shared` — бо `shared` версія має `.transform` до `SolanaSignature` branded type, а нам треба простий string для drizzle WHERE. Копія regex (~5 ліній) дешевша за caст через `as string` в route.
- **Партиційне зауваження у doc comment** — явно розумію що `WHERE signature = ?` не робить partition pruning, і чому це ок для MVP (index propagates до всіх child partitions → fast lookup across all). Якщо post-MVP volume зросте → додати materialized view `signature → block_time` для pruning.
- **`reasoningLogs: []` замість `null`** — stable response shape для frontend. Frontend може безпечно mapувати `logs.map(...)` без null guard.
- **`ORDER BY start_time ASC`** — chronological, природний порядок для timeline display у dashboard.
- **Mainnet-shape test signatures** (88 chars base58) замість fake `"sig-1"` — перевіряє, що `min(64).max(88)` в param schema приймає реальний формат. У agents.test.ts ми використовували короткі синтетичні signatures, бо там `signature` не валідується через zod (тільки як column у DB).

### Що зробили у 3.12
- `apps/api/src/routes/alerts.ts` — новий top-level router `createAlertsRouter(db)`:
  - `GET /` з query params: `agentId?` (uuid), `severity?` (z.enum(ALERT_SEVERITIES) з shared), `from?`/`to?` (ISO datetime з offset)
  - `.refine(from ≤ to)` валідація
  - **INNER JOIN** `alerts ↔ agents` з `WHERE agents.user_id = ?` + opt filters
  - `ORDER BY triggered_at DESC LIMIT 100` (MVP cap, no cursor)
  - Response: `{alerts: AlertRow[]}` — `.map(r => r.alert)` щоб avoid nested shape
- `apps/api/src/app.ts` — зареєстровано `createAlertsRouter` на `/api/alerts`
- `apps/api/tests/alerts.test.ts` — новий файл з **11 integration тестами**:
  1. No auth → 401
  2. Invalid severity (`extreme`) → 422 (enum guard)
  3. Non-uuid agentId → 422
  4. `from > to` → 422 (refine guard)
  5. Empty feed → `{alerts: []}`
  6. **Cross-tenant** — Alice seed'ить alert, Bob через другий `buildApp`/verifier бачить `[]`
  7. Global feed — 3 alerts across 2 agents, DESC by triggered_at
  8. **`severity=critical` filter** — task spec: "filter by severity=critical → тільки critical"
  9. `agentId` filter — narrow до одного агента
  10. `from/to` window — 10 hourly alerts, 03:00–06:00 → 4
  11. **Combined filters** (`agentId + severity`) — 3 alerts → 1 match
- `pnpm lint && pnpm typecheck && pnpm test` — все зелене. **144 tests total** (+11).

### Ключові рішення 3.12
- **INNER JOIN ownership pattern** — consistent з 3.11 transactions (один query, ownership у SQL). Drizzle subquery approach через `inArray(db.select())` теж би працював, але JOIN читабельніший і PG planner однаково оптимізує.
- **`.map(r => r.alert)`** — drizzle з `.select({alert: alerts})` повертає `{alert}` wrapper. Явне mapping перед response робить shape чистим для клієнта. Post-MVP може розглянути denormalized response з `agent.name` inline.
- **MVP hard-cap 100, no cursor** — alerts є "recent activity feed", не архів. Якщо юзер має >100 active alerts — у нього більш серйозні проблеми, ніж пагінація. Cursor можна додати post-MVP за тим самим keyset patter'ном як у 3.10.
- **`severity` з `ALERT_SEVERITIES` shared enum** — single source of truth. Якщо post-MVP додасться новий severity (`"emergency"`) — треба лише оновити константу у shared, route автоматично прийме.
- **`from`/`to` на `triggered_at`**, не `created_at`/`delivered_at` — бо dashboard хоче знати коли rule спрацював, не коли notification був надісланий. delivery_at ще може бути null.
- **Filters композабельні** — усі opt, applied в одному `and(...where)`. Default (no filters) = усі алерти юзера.

## 🎉 ЕПІК 3 ЗАКРИТО ✅
Повний REST API готовий:
- Agents CRUD: POST/GET/GET:id/PATCH/DELETE
- Transactions: list (keyset pagination), single (з reasoning join)
- Alerts: feed з фільтрами
- Foundation: Hono + error middleware + Privy auth + SSE bus + buildApp factory

**88 api тестів** покривають всю surface. PGlite integration tests для owner-scoped queries, cross-tenant isolation, validation edge cases.

Наступний епік — **Epic 4: Reasoning Collector** (OTLP receiver для AI agent reasoning spans). Задачі 4.1-4.7.

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
