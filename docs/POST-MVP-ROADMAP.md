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

### E.8 — Security scanning у CI
- [ ] **E.8** (додано 2026-07-28) `pnpm audit --audit-level=high` крок у [.github/workflows/ci.yml](../.github/workflows/ci.yml) + CodeQL workflow (JS/TS) + Dependabot або Renovate config на security-only updates. Зараз CI = lint/typecheck/test/build, **нуль security-сканів**, хоча репо має публічний `SECURITY.md` з обіцянкою reporting-процесу
  ⏱ 0.5 дня · 📦 v0.5.1-infra · 🎯 *(internal/ops — без твіту, або мінорна згадка у self-host anons)*
  **Файли:** `.github/workflows/ci.yml` (+audit step) · `.github/workflows/codeql.yml` (новий) · `.github/dependabot.yml` — security-only, щоб не воювати з no-deps правилом
  **Обґрунтування:** ми продаємо observability для гаманців з реальними коштами. Публічний репо без жодного сканування — суперечність між `SECURITY.md` і практикою. Zero нових runtime-депів (усе GitHub-native).

### E.9 — Release automation (tag → GitHub Release)
- [x] **E.9** (2026-07-31) Workflow на push тега `v*`: витягнути відповідну секцію з `CHANGELOG.md` → `gh release create --notes-file` з тими notes. Зараз реліз-нотатки робляться вручну і **процес уже двічі відставав** — три коміти поспіль (`747f0e5`, `b267a65`, `f1337ad`) були саме backfill-ом пропущених секцій CHANGELOG
  ⏱ 0.5 дня · 📦 v0.5.6 (рекомендовано замість `v0.5.2-infra` — суфіксовані теги ніколи не використовувались на практиці) · 🎯 *(internal/ops)*
  **Файли:** [.github/workflows/release.yml](../.github/workflows/release.yml) (новий) · [scripts/extract-changelog-section.ts](../scripts/extract-changelog-section.ts) (pure + CLI) · [scripts/tests/extract-changelog-section.test.ts](../scripts/tests/extract-changelog-section.test.ts) (16 тестів) · `scripts/vitest.config.ts` + `test` скрипт у `scripts/package.json` (пакет раніше взагалі не мав тестів → turbo test 18 → 19 tasks)
  **Обґрунтування:** roadmap вимагає «кожен пункт = окремий git tag + GitHub Release notes» — але це найпростіша річ, яку solo-розробник забуває першою. Автоматизація дешевша за дисципліну.
  **Дизайн-рішення:**
  1. **Матчинг за версією, не за позицією.** `CHANGELOG.md` НЕ у монотонному порядку (0.5.2 випущено пізніше за 0.5.3 і лежить вище) — будь-який «візьми першу секцію» підхід віддав би не ту.
  2. **Fail loudly, publish nothing.** Тег без секції → workflow червоний зі списком наявних версій, релізу не створює. Саме цей gap і ловимо: `v0.4.4`/`v0.4.6`/`v0.4.7` затеговані до написання секцій.
  3. **Trailing link-refs зрізаються** — `[0.5.2]: https://…` живуть у кінці файлу і інакше потрапили б у нотатки найстарішої секції.
  4. Суфіксовані теги (`v0.5.0-admin`) підтримуються екстрактором, якщо для них є секція з таким самим рядком.
  **Zero нових депів:** `vitest` резолвиться з root `node_modules/.bin`, `tsx` уже у devDeps `scripts`, `gh` — на GitHub runner'ах з коробки.

### E.10 — Публічна status-сторінка
- [ ] **E.10** (додано 2026-07-28) `status.agentscopehq.dev` — UptimeRobot free (50 monitors) на `/health` api + ingestion + dashboard, публічний status-page, лінк у футері landing + dashboard. Довіра для білдерів, які думають вести на нас продакшн-агента
  ⏱ 2 год · 📦 v0.5.3-infra · 🎯 *"AgentScope now has a public status page. If we're down, you'll see it before you have to ask. Observability tools that don't publish their own uptime are asking for trust they haven't shown."*
  **Файли:** external (UptimeRobot config) · `apps/landing/src/components/Footer.astro` · `apps/dashboard/src/components/shell/` footer link
  **Залежність:** нуль коду в критичному шляху; `/health` уже існує і навмисно не чіпає DB.

### E.11 — Backup / restore runbook
- [ ] **E.11** (додано 2026-07-28) Supabase **free tier не має PITR** — зараз втрата проєкту = втрата всіх даних білдерів і всієї грантової звітності. Scheduled GH Action: `pg_dump` (schema + data, без RLS-ролей) → зашифрований artifact з 30-денною retention. `docs/DEPLOY.md` §10 — restore-процедура (§9 зайняв E.13), перевірена на локальному Postgres хоча б раз
  ⏱ 1 день · 📦 v0.5.4-infra · 🎯 *(internal/ops — без твіту)*
  **Файли:** `.github/workflows/backup.yml` (новий, cron daily) · `docs/DEPLOY.md` §10 «Backup & restore»
  **Обґрунтування (аналіз 2026-07-28):** єдиний ризик у списку, що **не має ліміту збитку**. Усе інше в Cluster E — про вартість і швидкість; це про існування проєкту. Grant proof-артефакти живуть у тій самій БД.

### E.12 — Schema-drift checker (🔴 інцидент 2026-07-31)
- [x] **E.12** (2026-07-31) `scripts/check-schema-drift.ts` — звіряє живу БД з `packages/db/src/schema.ts` і повертає ненульовий exit-код при розходженні. Очікування виводяться з самих drizzle-об'єктів через `getTableConfig`/`isPgEnum`, не зі списку, який треба підтримувати руками. Перевіряє: значення enum-ів, наявність таблиць і колонок, наявність індексів **та їхню унікальність**, RLS на всіх таблицях і партиціях. 16 тестів
  ⏱ 0.5 дня · 📦 v0.5.6 · 🎯 *(internal/ops — без твіту)*
  **Файли:** [scripts/check-schema-drift.ts](../scripts/check-schema-drift.ts) · [scripts/tests/check-schema-drift.test.ts](../scripts/tests/check-schema-drift.test.ts) · `check-schema-drift` скрипт у `scripts/package.json`
  **🔴 Інцидент, який це породив (2026-07-31).** Під час накочування `0017` (A.11) аудит показав, що у проді **ніколи не застосовувались шість міграцій**: `0007` (таблиця `telegram_bindings`), `0008`, `0011`, `0012`, `0013`, `0016` (сім значень `alert_rule_name`) і `0009` (`agents.alerts_paused_until` + `delivery_status='skipped'`). Наслідки, які жили в проді непоміченими:
  - Сім правил детектора спрацьовували, але вставка алерта відхилялась Postgres'ом через невідоме значення enum.
  - У **cron**-шляху вставка не обгорнута в try/catch — виняток вилітав з `runCronCycle` і вбивав **весь цикл**, тобто агенти після проблемного не отримували того тіку взагалі нічого, включно з правилами, у яких з enum усе гаразд. І так кожні 60 секунд.
  - У **tx**-шляху `persist.ts` ловив виняток і писав `detector runner failed` — губився лише алерт.
  - Непоміченим лишалось тому, що збій виникає **лише коли одне з семи правил реально спрацьовує**: на спокійних агентах усе виглядало нормально.
  **Чому дисципліна не спрацювала:** журнал drizzle обривається на `0009`, тож `db:migrate` міграції `0010`+ не бачить, а `db:push` для цього репо небезпечний (диф усієї схеми без знання про партиції, RLS і enum-ALTER'и → пропонує їх знести). Реальний процес був «накотити руками через SQL-редактор» — і він тихо провалився шість разів. **Це вже другий випадок того самого класу:** міграція `0014` (v0.4.x) з'явилась рівно тому, що `0010` не доїхала у прод тим самим шляхом. Перший раз полагодили наслідок, не процес.
  **Обмеження:** чотири SQL-запити, якими CLI читає стан, у CI не виконуються (потрібна жива БД) — покрита тестами лише чиста порівняльна логіка. Самі запити прогнані вручну проти прода 2026-07-31 і дали коректний результат.
  **Наступний крок (не зроблено):** повісити чекер у CI перед деплоєм — зараз його треба запускати руками.

### E.13 — Self-monitoring: ingestion heartbeat + edge-triggered alert (🔴 інцидент 2026-07-30 → 08-11)
- [x] **E.13** (2026-08-22) `service_heartbeats` + `GET /health/ingestion` + переписаний uptime-workflow. Ingestion щo30с апсертить рядок зі своїми liveness-сигналами (старт процесу, останній slot з WS, остання tx, останній **успішно завершений** cron-цикл, к-сть підписаних гаманців); API читає його і віддає 200/503; workflow пінгує **обидва** сервіси кожні 15 хв і шле в admin-Telegram **на переходах** стану. 21 тест (15 api + 6 ingestion)
  ⏱ 0.5 дня · 📦 v0.5.9 · 🎯 *«Наш алертинг дві доби лежав і нікому не сказав. Тепер він будить нас першим.»*
  **Файли:** [apps/ingestion/src/heartbeat.ts](../apps/ingestion/src/heartbeat.ts) · [apps/api/src/routes/health.ts](../apps/api/src/routes/health.ts) · [.github/workflows/keep-alive.yml](../.github/workflows/keep-alive.yml) · міграція `0019_service_heartbeats.sql` · `onCycleComplete` у [apps/ingestion/src/cron.ts](../apps/ingestion/src/cron.ts)
  **🔴 Інцидент, який це породив.** Ingestion помер **30 липня** (правило A.9 спрацювало → INSERT впав на невідомому enum → процес ліг → Railway у циклі рестартів; це та сама дірка, що породила E.12). Виявили **11 серпня** — 12 днів без жодної tx і жодного алерта. `Keep Railway alive` при цьому був зелений до 08-08, бо пінгував **api**, а помер **ingestion**: два процеси, дві незалежні відмови, спостерігали за одним. А коли пінг таки почервонів — він падав мовчки в Actions і не писав нікуди. Продукт для алертингу лежав дві доби і не сповістив власника.
  **Три рішення, які варто пам'ятати:**
  - **Heartbeat-таблиця, а не похідний запит.** «Тихий флот» і «мертвий воркер» виглядають однаково у `agent_transactions`, тож tx-lag не є сигналом життя. Рядок пишеться незалежно від трафіку — його відсутність означає рівно одне. Тому ж `/health/ingestion` **ніколи не судить про вік останньої tx** (віддає його довідково): 12 днів тиші у флоті сплячих агентів — норма, і алерт на це = алерт-фатіга.
  - **Сигнали, а не тільки timestamp.** Процес, що живий, але чий WS перестав віддавати слоти, мертвий у всьому, що важить для юзера — зовнішній пінг такого не бачить. Так само `cron-stalled`: `onCycleComplete` викликається **лише після циклу без винятку**, тож вічно-падаючий cron (липневий сценарій, якби він не вбивав процес) видно як окрему причину. Сигнал, що ще не спрацьовував, старіє від старту процесу — свіжо завантажений воркер не «протух».
  - **Edge-triggered, не level-triggered.** Нотифікація на переході (down→ ok→), стан читається з conclusion попереднього run'а через `gh run list`. 12-денна аварія = 2 повідомлення, а не 1152. Job усе одно падає на кожному червоному run'і — це і видимий сигнал в Actions, і стан, який workflow читає наступного разу.
  **⚠️ Потребує дій власника (без них фіча наполовину мертва):** (1) накотити `0019` у Supabase SQL-редакторі + `check-schema-drift`; (2) додати GitHub repo secrets `TELEGRAM_BOT_TOKEN` і `TELEGRAM_ADMIN_CHAT_ID` — без них workflow тихо пропускає нотифікацію (лишається тільки червоний run).
  **Граблі, знайдені при валідації (2026-08-22, комміт `2d41fe3`):** у job'і нема `actions/checkout`, тож `gh run list` не має з чого визначити репозиторій і падає — а `2>/dev/null || echo ""` перетворював це на порожній `prev`, тобто edge-triggered тихо деградував у level-triggered рівно на час аварії. Фікс: `GH_REPO: ${{ github.repository }}` + stderr більше не глушиться. **Урок ширший за цей баг:** fallback, який ковтає помилку, міняє семантику алертингу мовчки.
  **Ще не доведено:** сам виклик `sendMessage` жодного разу не виконувався — він за визначенням спрацьовує лише на ребрі, а стан зелений. Кандидат: `workflow_dispatch` input `test_notification`, щоб перевіряти шлях доставки не чекаючи аварії (~10 рядків).
  **Не зроблено свідомо:** порогів у env не винесено (180с heartbeat / 300с slot / 300с cron — виведені з відповідних каденсів 30с/400мс/60с, крутити нема сенсу); `/health/ingestion` не потрапив у Prometheus `/metrics` — там нема кому скрейпити, поки не з'явиться E.10.

### E.14 — Ingestion memory ramp → регресія рахунку Railway (🔴 інцидент: $5 → $18.04)

- [x] **E.14** (2026-08-27) Рахунок Railway за 23.07-23.08 склав **$18.04** проти ~$5 попередніх місяців; $17.79 з них — пам'ять (1.72 GB середнього на api+ingestion проти ~0.5 GB). Графік RAM — пилка: лінійний підйом ~200 MB/добу, який обнулявся **тільки деплоєм**. Закрито трьома змінами: дочитування тіл `fetch`, heap-cap через Custom Start Command, і діагностика пам'яті на heartbeat, яка й дала відповідь.
  ⏱ 0.5 дня · 📦 v0.5.10 (2026-09-22, разом з E.15) · 🎯 *«Наш білл виріс утричі. Виявилось, це не heap — це мертві сокети від запитів, які ніхто не дочитував.»*
  **Файли:** [packages/shared/src/drain-body.ts](../packages/shared/src/drain-body.ts) + [5 тестів](../packages/shared/tests/drain-body.test.ts) · `MemorySignals`/`readMemorySignals` у [apps/ingestion/src/heartbeat.ts](../apps/ingestion/src/heartbeat.ts) · шість call-site'ів `fetch`: [event-publisher.ts](../apps/ingestion/src/event-publisher.ts), [telegram-bot.ts](../apps/ingestion/src/telegram-bot.ts), [abuse-monitor.ts](../apps/ingestion/src/abuse-monitor.ts), [webhook.ts](../packages/alerter/src/webhook.ts), [telegram.ts](../packages/alerter/src/telegram.ts) · коміти `f1d1a90`, `06573c0`
  **Три речі, які варто памʼятати:**
  - **Незчитане тіло `fetch` — це витік.** Node (undici) не звільняє тіло лише тому, що ніхто його не прочитав: буфер лишається на купі, а сокет не повертається у пул до збірки `Response`. На холодних шляхах невидимо; `event-publisher` стріляє **на кожну збережену tx і на кожен алерт**. `drainBody` саме **дочитує**, а не `cancel()`-ить: скасування змушує undici знищити зʼєднання, а повне читання звільняє буфер і лишає сокет придатним.
  - **`--max-old-space-size` не обмежує те, що росло.** Фінальний діагноз: росли `external`/`arrayBuffers`, а не JS-heap. У заклиненого воркера `arrayBuffersMb=260` і +1 MB кожні 5 хв (~290 MB/добу — той самий порядок, що й на графіку), при `heapUsedMb` рівно 290. У здорового після рестарту — `arrayBuffersMb=4`. Heap-cap лишається як страховка, але причину він не лікував **у принципі**.
  - **Змінна `NODE_OPTIONS` на Railway діє і на білд.** 384 MB у вкладці Variables вбили vite-збірку дашборда (`Reached heap limit`, exit 134). Правильне місце — Settings → Deploy → **Custom Start Command**, там прапорець живе лише в процесі, який стартує після білду.
  **Підтверджено (2026-08-30):** 64 год безперервного аптайму, крива пласка — `rssMb` 167 → 166 за останні 16 год, `external` 7-8, `arrayBuffers` 3-4. Заміряний біллінг за 27-30.08: 1728.7 GB-min за 4336 хв = **0.40 GB середнього**, тобто ~**$4/місяць** проти $18.04. Нижче за докризовий рівень.
  **Не зроблено свідомо:** прод усе ще стартує через `tsx src/index.ts`, хоча обидва додатки збираються `tsc`. Перехід на `node dist/src/index.js` зрізав би ~200 MB non-heap baseline, але **заблокований**: усі воркспейс-пакети резолвлять `@agentscope/*` у `./src/index.ts`, а всередині цих джерел відносні імпорти без розширень, чого NodeNext ESM не приймає. Перевірено запуском скомпільованого виводу: `ERR_MODULE_NOT_FOUND` на `packages/alerter/src/deliver`. Переробка `exports` — окрема задача. Також не чіпали Railway Config-as-code path: сервіси не підхоплюють `apps/*/railway.json`, тож білд щоразу збирає всі 14 пакетів включно з дашбордом і лендінгом, яких на Railway взагалі нема.

### E.15 — Self-kill watchdog: воркер, що живий і не працює (🔴 інцидент 2026-08-25, 40 год простою)

- [x] **E.15** (2026-08-27) Воркер **40 годин не обробив жодної транзакції — і жодного разу не впав**. Railway показував `RUNNING`, `uptimeSec` ріс, 60-секундний cron-таймер цокав. Cron-цикл стартував о 17:33 і не повернувся, тож `running` у [cron.ts](../apps/ingestion/src/cron.ts) лишився пінянутим назавжди, а кожен наступний тік писав лише «cron cycle skipped». Записи heartbeat висіли на тій самій мертвій мережі й заморозили рядок посеред аварії. Тепер воркер судить себе тими самими сигналами, що й API, і виходить з ненульовим кодом; `restartPolicyType: ON_FAILURE` робить з цього свіжий контейнер.
  ⏱ 0.5 дня · 📦 v0.5.10 (2026-09-22, разом з E.14) · 🎯 *«Процес був живий 40 годин і не зробив нічого. Тепер він вбиває себе за 10 хвилин, бо це єдиний доступний йому спосіб одужати.»*
  **Файли:** [apps/ingestion/src/watchdog.ts](../apps/ingestion/src/watchdog.ts) + [16 тестів](../apps/ingestion/tests/watchdog.test.ts) · `cycleTimeoutMs` + `Promise.race` у [cron.ts](../apps/ingestion/src/cron.ts) + [2 тести](../apps/ingestion/tests/cron.test.ts) · `heartbeat.marks()` з `lastWriteOkAtMs` у [heartbeat.ts](../apps/ingestion/src/heartbeat.ts) · коміти `880cfb4`, `0116e44`, `549b663`
  **Три рішення, які варто памʼятати:**
  - **Моніторинг спрацював повністю — і не допоміг.** `/health/ingestion` віддавав 503, workflow почервонів, Telegram надіслав о 18:04. Але процес, який живий і нічого не робить, **невидимий для restart-політики на кодах виходу**, і стоїть, доки людина не помітить. Не вистачало не сигналу, а того, хто на нього діє. Смерть — єдине доступне одужання: ніщо всередині процесу не скасує `fetch`, який ніколи не завершиться.
  - **Boot grace для сигналів, що ще не спрацьовували** — зловлено на живому проді **за півгодини до того, як воно поїхало б**. `backfillNewWallets` обходить кожен зареєстрований гаманець по 20-45 с; на рестарті 27.08 два перші цикли пропустились, а перший **завершений** прийшов на 6.5-й хвилині. Плаский поріг у 10 хв убивав би воркер посеред кожного завантаження: смерть → рестарт → backfill спочатку → ніколи не сходиться. Розрізняти треба не «наскільки старий сигнал», а «чи він працював і зупинився»: мітка, що спрацьовувала, судиться з першої секунди (це і є підпис 25.08), мітка, що досі `null`, отримує годину кредиту.
  - **Дедлайн на цикл не скасовує зависле.** `Promise.race` лише звільняє `running`, а зависла робота крутиться у фоні — у Node її нічим не скасувати. `onCycleComplete` навмисно висить на самому циклі, а не на race: інакше таймаут рахувався б як успішний тік, і сигнал, який читає watchdog, брехав би.
  **Пороги:** `stream-stalled` / `cron-stalled` / `heartbeat-write-stalled` — 10 хв кожен (≈2× від порогів звітності API), boot grace 60 хв. Асиметрія навмисна: 503 коштує червоного дашборда, хибне самогубство — рестарту і провалу в інжесті. **Вік транзакції не судиться ніколи** — сплячий флот перетворив би тиждень тиші на петлю рестартів (те саме свідоме упущення, що й у `health.ts`).
  **Першопричину не встановлено.** Що саме обірвало вихідну мережу контейнера о 17:33 — інцидент Railway, збій Helius чи щось третє — логи не кажуть. Watchdog цього не лікує, він лише скорочує наслідок з 40 годин до ~10 хвилин.
  **Не зроблено свідомо:** RPC-виклики `@solana/web3.js` досі без власного таймауту (`getMultipleAccountsInfo`, `getTransaction` можуть висіти вічно) — дедлайн на цикл це обходить, але не усуває; пороги не винесені в env (виведені з каденсів, крутити нема сенсу); `E.10` публічна status-сторінка досі відкрита, а вона єдина закрила б «ніхто не подивився на червоний run 39 годин».

**Cluster E total:** ~9 днів, 13 micro-releases (v0.4.3 → v0.5.10). **E.1 + E.2 — must-have для M3 на free-tier; E.7 — deploy-safety; E.11 — єдиний пункт з необмеженим збитком при відмові; E.12, E.13, E.14, E.15 — наслідки інцидентів 2026-07-31, 2026-07-30/08-11, 2026-08-23 (білл) і 2026-08-25 (40 год простою).**

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
- [x] **A.6** (commit [`f25b1b2`](https://github.com/PavloDereniuk/AgentScope/commit/f25b1b2), 2026-07-14) Парсер для Drift v2 (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`) — класичні order-інструкції агента: `place_perp_order`, `place_orders`, `place_and_take_perp_order`, `cancel_order`, `cancel_orders` + collateral `deposit`/`withdraw`. 13 TDD тестів, 9 fixtures, 18/18 turbo зелені.
  ⏱ 3 дні · 📦 v0.5.2 · 🎯 *"AgentScope now parses Drift perp orders — leverage agents are finally observable end-to-end. Place, cancel, size, direction, market index — all with real semantics."*
  **Файли:** [packages/parser/src/drift/idl.json](../packages/parser/src/drift/idl.json) · [packages/parser/src/drift/parser.ts](../packages/parser/src/drift/parser.ts) · [packages/parser/tests/drift.test.ts](../packages/parser/tests/drift.test.ts) · 9 fixtures (drift-*) · [scripts/fetch-drift-fixtures.ts](../scripts/fetch-drift-fixtures.ts)
  **🔴 Скоуп-рішення (власник, 2026-07-14):** decode тільки **класичні order-інструкції, які надсилає сам агент** через standard `@drift-labs/sdk`. НЕ keeper-side `fill_*` / Swift signed-message інструкції.
  **🔴 Відхилення від roadmap (важливо):** roadmap казав "placeOrder, **fillOrder**, cancelOrder", але `fill_perp_order` — це keeper-дія (виконує чужий ордер), не те, що надсилає моніторений агент. Замість fill додано `place_orders` (batch), `place_and_take_perp_order` (market-order path) + deposit/withdraw.
  **🔴 Fixtures IDL-constructed, НЕ mainnet-caught (свідоме відхилення від TDD-дисципліни, погоджено):** станом на 2026-07 Drift order-flow майже повністю мігрував на **Swift signed-message orders** (подають keeper'и; домінантні outer-дискримінатори `ef10c888…`/`033a28eb…` **відсутні навіть у найновішому опублікованому IDL** v2.162.0). Класичні outer place/cancel виклики недосяжні жодним pagination-вікном — просканував **>6000 свіжих tx усіма стратегіями (deep-history, trader-authorities), нуль hits**. Тому fixtures згенеровано за офіційним IDL-layout (генератор з web3.js-серіалізацією), а bytes звірено проти двох авторитетних IDL-джерел.
  **Верифікація (звірено, не з пам'яті):** дискримінатори = sha256("global:<snake>")[..8], звірені проти on-chain Anchor IDL (v2.150.0) + GitHub protocol-v2 (v2.162.0). Program state PDA `5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN` (findProgramAddress(["drift_state"])) підтверджено on-chain owned by program. `OrderParams` layout — verbatim з IDL type. Незалежний декодер підтвердив усі офсети.
  **Дизайн-нотатки:** усі поля, що читає парсер (orderType/marketType/direction/marketIndex/baseAssetAmount/price/reduceOnly), лежать на фіксованих офсетах ПЕРЕД першим Option-полем `OrderParams` (maxTs) → decode робастний до будь-яких реальних tx незалежно від trailing-опцій. Account-позиції різні: place3 → authority@2; place_and_take → authority@3 (userStats@2); deposit/withdraw → authority@3. `deposit` disc = `f223c68952e1f2b6` збігається з Marinade's deposit (обидва sha256("global:deposit")), але dispatcher маршрутизує по programId → без конфлікту.

### A.7 — Marinade liquid staking parser
- [x] **A.7** (commit [`bd55a9c`](https://github.com/PavloDereniuk/AgentScope/commit/bd55a9c), 2026-07-07) Парсер для Marinade — `deposit`, `liquid_unstake`, `order_unstake`, `claim`. 12 TDD тестів, 6 mainnet fixtures (2 deposit, 2 liquid_unstake, 1 order_unstake, 1 claim). Стейкінг має простіший shape ніж DEX — тільки SOL↔mSOL, тому args плоскі (`amountLamports`/`msolAmount` + `stateAddress`), без swap-стилю `{inputMint,outputMint}`.
  ⏱ 2 дні · 📦 v0.5.3 · 🎯 *"Marinade staking now visible. Yield-strategy agents that route between Kamino and Marinade — fully observable from a single dashboard."*
  **Файли:** [packages/parser/src/marinade/idl.json](../packages/parser/src/marinade/idl.json) · [packages/parser/src/marinade/parser.ts](../packages/parser/src/marinade/parser.ts) · [packages/parser/tests/marinade.test.ts](../packages/parser/tests/marinade.test.ts) · [scripts/fetch-marinade-fixtures.ts](../scripts/fetch-marinade-fixtures.ts)
  **🔴 Виправлення адреси програми (важливо):** оригінальний roadmap-запис `MarBmsSgKXdrN1egZf5sqe1TMThiYsCfVuvAJBbQNTQ` — **неіснуючий акаунт на mainnet** (`getAccountInfo` → null, перевірено). Правильна адреса `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` — звірена проти `docs.marinade.finance/developers/contract-addresses` + живого `getAccountInfo` (executable BPF program) ПЕРЕД написанням парсера. Схоже, попередня сесія записала roadmap-адресу з пам'яті без верифікації — урок: завжди звіряти program ID проти on-chain стану чи офіційної документації, ніколи з training-пам'яті.
  **Дизайн-нотатки:** `claim` не має числового аргументу в instruction data (лише 8-байтовий дискримінатор) — сума криється в ticket-акаунті, тому парсер повертає `reservePda`+`ticketAccount` замість суми. `order_unstake` додано понад точний roadmap-опис (deposit/liquidUnstake/claim) — без нього `claim` не мав би парного інструменту створення тікета delayed-unstake; обидва мають однаковий shape (disc + u64 msol_amount), тому додавання дешеве. `deposit_stake_account` (10 випадків у 463 tx сканування) свідомо НЕ реалізовано — поза точним описом задачі. accounts[0]=state підтверджено на всіх 4 інструкціях проти офіційної docs-адреси; `liquid_unstake`'s accounts[4]=treasuryMsolAccount і `claim`'s accounts[1]=reservePda також збігаються з офіційними docs-адресами один-в-один.

### A.8 — Priority fee anomaly rule
- [x] **A.8** `priority_fee_spike` rule — fee у tx > N × median fee для цього програма за останні 24h. Захист від тихих overpay-bug'ів (наприклад, неправильно встановлений ComputeBudget instruction)
  ⏱ 1 день · 📦 v0.5.4 · 🎯 *"Your agent silently paid 200x normal priority fee on this swap. AgentScope now flags it — most observability tools don't even surface compute budget."*
  **Файли:** `packages/detector/src/rules/priority-fee.ts` + tests · Reuse `gas_spike` median-query pattern

### A.9 — Unknown program interaction rule
- [x] **A.9** (2026-07-28, released) `unknown_program_interaction` rule — агент вперше викликає програму, якої нема ні в `KNOWN_PROGRAMS`, ні в його власній історії за N днів (default 30). Severity=warning, escalate=critical якщо у тій самій tx є SOL/SPL outflow. Дешево: історія вже у `agent_transactions`, whitelist уже у парсері
  ⏱ 1 день · 📦 v0.5.5 · 🎯 *"Your agent just called a program it has never touched before — and moved funds in the same transaction. AgentScope now flags first-contact with unknown programs. The #1 way agent wallets get drained, caught at the first hop."*
  **Файли:** [packages/detector/src/rules/unknown-program.ts](../packages/detector/src/rules/unknown-program.ts) + [17 тестів](../packages/detector/tests/unknown-program.test.ts) · новий [packages/parser/src/known-programs.ts](../packages/parser/src/known-programs.ts) (`KNOWN_PROGRAMS` винесено з dispatcher + `isKnownProgram`) · `packages/shared/{types,schemas,format-alert}.ts` · DB migration 0016 · +1 e2e тест у [apps/ingestion/tests/detector-runner.test.ts](../apps/ingestion/tests/detector-runner.test.ts)
  **Обґрунтування (аналіз 2026-07-28):** усі 13 наявних правил ловлять «технічно щось зламалось» (slippage, gas, stale, rate, balance). **Жодне не покриває security-вектори** — а саме через них агентські гаманці реально помирають. A.9-A.11 закривають цю категорію.
  **🔴 Дизайн-відхилення від roadmap-опису (важливо):**
  1. **Скануємо ВСІ інструкції tx, не лише primary.** `pickPrimaryInstruction` віддає перевагу *розпарсеним* інструкціям — дренажер, що приїхав CPI поруч зі справжнім Jupiter-свопом, ніколи не став би `programId` цієї tx. Правило читає компактний `_all` outline (E.5) з `parsedArgs`, fallback — `transaction.programId`. Без цього правило ловило б лише найпримітивніший випадок.
  2. **Cold-start abstain:** агент без історії у вікні не має бази для порівняння — мовчимо, замість вітати нового юзера стіною алертів. Той самий підхід, що у `priority_fee_spike`.
  3. **Dedupe по програмі І severity** (`unknown_program:<pid>:<severity>`), не лише по програмі: інакше нешкідливий перший контакт назавжди проковтнув би critical-алерт наступної tx, що реально виводить кошти.
  **Вартість:** 2 індексовані запити на tx з невідомою програмою (distinct-програми, потім cold-start — тільки коли є що репортити); tx лише з відомими програмами не платять нічого понад lookup у whitelist. SOL-outflow рахується у lamports через `BigInt`, не `parseFloat`. Нових runtime-депів нема (`@agentscope/parser` у detector — workspace-лінк на subpath без web3.js/Anchor).
  **⚠ Prod action:** накотити SQL міграції у Supabase SQL-редакторі ПЕРЕД деплоєм ingestion — enum-значення має існувати до першої вставки алерта. НЕ через `db:push` (див. E.12). Після — `pnpm --filter @agentscope/scripts check-schema-drift`.

### A.10 — Token approval / delegate anomaly
- [x] **A.10** (2026-08-11) `token_approval_anomaly` rule + SPL Token парсер — `approve`/`approve_checked` на delegate поза історією агента (30 днів), або `amount == u64::MAX`. Critical коли unlimited І delegate незнайомий, інакше warning. 14 TDD тестів парсера + 19 тестів правила + 1 e2e через `runTxDetector`, міграція `0018`
  ⏱ 1.5 дня · 📦 v0.5.8 · 🎯 *"Unlimited token approval to an address your agent has never seen? That's how wallets get emptied while you sleep. AgentScope now decodes SPL approve instructions and alerts on the delegate — not just on the transfer that comes after."*
  **Файли:** [packages/parser/src/spl-token/parser.ts](../packages/parser/src/spl-token/parser.ts) · [packages/parser/src/binary.ts](../packages/parser/src/binary.ts) (винесено з `system/parser.ts`) · [packages/detector/src/rules/token-approval.ts](../packages/detector/src/rules/token-approval.ts) · [packages/db/src/migrations/0018_token_approval_anomaly.sql](../packages/db/src/migrations/0018_token_approval_anomaly.sql) · persist/detector-runner/shared/dashboard wiring
  **Скоуп парсера:** `transfer`, `transfer_checked`, `approve`, `approve_checked`, `revoke` — фіксовані layout-и, які рухають або делегують кошти. Token і Token-2022 мають байт-ідентичні layout-и для всіх п'яти → один декодер, один namespace `spl_token`, два зареєстровані programId. Mint/burn/lifecycle і extension-діапазон Token-2022 (disc ≥ 43) → `spl_token.unknown`.
  **🔴 Токенова частина A.11 НЕ закрита.** Парсер був необхідною, але не достатньою умовою: у SPL transfer-і `destination` — це **токен-акаунт, а не гаманець**, тож щоб судити counterparty, потрібен мепінг account → owner, якого persist не зберігає. Окремий follow-up, не побічний ефект A.10.
  **Дизайн-рішення:**
  1. **Unlimited спрацьовує без baseline** — `u64::MAX` це властивість самого гранту, а не судження про історію. Cold-start abstain лишається лише для «незнайомий delegate» (слабший сигнал); дренаж на першу добу життя агента інакше пройшов би повз.
  2. **«Знайомий» = раніше **approve**-нутий** за фіксовані 30 днів (як A.9/A.11, без другого тюнера). Попередні *перекази* на адресу не роблять її знайомим delegate — заплатити комусь і дозволити брати самому це різні дії.
  3. **Правило читає `_approvals`, не primary args** — `spl_token.*` навмисно демотовано у utility-tier `pickPrimaryInstruction` (інакше кожен swap із token-transfer'ом перелейбився б у `spl_token.transfer` і зламав slippage-правилам args). Тому approve за swap-ом невидимий на верхньому рівні `parsed_args` — саме та форма, якою користується дренер.
  4. **Dedupe по delegate + mint + severity** — один delegate на двох мінтах це дві різні експозиції.
  **Вартість:** 2 запити на tx, що містить approve (jsonb-containment по історії + cold-start пробa лише коли є що репортити), **0** на решті. Нових депів нема.
  **⚠ Prod action:** накотити `0018` у Supabase SQL-редакторі ПЕРЕД деплоєм ingestion, потім `pnpm --filter @agentscope/scripts check-schema-drift`. НЕ через `db:push` (E.12).

### A.11 — Outbound transfer drain
- [x] **A.11** (2026-07-31) `outbound_transfer_drain` rule — серія SOL transfer-ів на адреси поза відомим набором counterparty агента у межах 15-хв вікна, сумарно > X% (default 25%) від балансу на початок вікна. Cron-triggered, escalate=critical при 2× порогу. Ловить повільний дренаж дрібними сумами, який per-tx правила пропускають. 21 TDD тест + 1 e2e через `runCronCycle`, міграція `0017`
  ⏱ 1 день · 📦 v0.5.7 · 🎯 *"Drains don't always come as one big transfer. AgentScope now watches the aggregate: a run of small outbound transfers to fresh addresses that adds up to a meaningful slice of the wallet fires an alert — even when no single tx looks wrong."*
  **Файли:** [packages/detector/src/rules/transfer-drain.ts](../packages/detector/src/rules/transfer-drain.ts) · [packages/detector/tests/transfer-drain.test.ts](../packages/detector/tests/transfer-drain.test.ts) · [packages/detector/src/lamports.ts](../packages/detector/src/lamports.ts) (винесено з `unknown-program.ts`) · [packages/db/src/migrations/0017_outbound_transfer_drain.sql](../packages/db/src/migrations/0017_outbound_transfer_drain.sql) · cron/shared/dashboard wiring
  **🔴 Скоуп-відхилення від roadmap-опису (важливо):** roadmap казав «SOL/**SPL** transfer-ів». **SPL-леґ не реалізовано** — persist зберігає decoded args лише для primary-інструкції (E.5 storage diet), а SPL Token взагалі не декодується. Адреса-отримувач існує рівно тоді, коли primary = `system.transfer`. Токенову частину закриє **A.10** разом з SPL Token парсером. SOL, що виходить через swap, теж не рахуємо — там нема counterparty, якого можна судити.
  **Дизайн-рішення:**
  1. **Баланс на початок вікна реконструюється, не зберігається:** `start = current − Σ sol_delta(window)`. Саме *знакова* сума (а не лише outflow) обнуляє поповнення всередині вікна — інакше щойно профінансований агент виглядає безпечним, поки його дренять. `start <= 0` → abstain (дані суперечать одні одним).
  2. **Той самий self-check ловить inbound:** вхідні перекази лежать як `system.transfer` з гаманцем агента у `to` — без цієї перевірки кожне поповнення читалось би як дренаж.
  3. **«Знайомий» = платили ДО відкриття вікна** (фіксовані 30 днів, не конфігуровані). Перекази всередині вікна не роблять свій же destination знайомим — інакше перший хоп дренажу вибілив би всі наступні. Другий тюнер «у днях» дав би більше support-питань, ніж сигналу.
  4. **Cold-start abstain** — як A.9 і `priority_fee_spike`.
  5. **Dedupe по 15-хв бакету** (як `tx_rate_anomaly`): один алерт на вікно, новий — після перекочування, бо активний дренаж має пейджити далі, а не замовкнути після першого хіта.
  **Вартість:** 1 індексований запит на агента за цикл у типовому випадку (нема transfer-ів за 15 хв → вихід). Решта (counterparty-lookup, cold-start, сума дельт, баланс) — лише коли є що репортити; баланс бере прогріте prime-кеш (E.1), тобто **0 нових RPC**.
  **⚠ Prod action:** накотити SQL міграції у Supabase SQL-редакторі ПЕРЕД деплоєм ingestion — enum-значення має існувати до першої вставки алерта. НЕ через `db:push` (див. E.12). Після — `pnpm --filter @agentscope/scripts check-schema-drift`.

### A.12 — pump.fun / memecoin launchpad parser ⚠️ ПОТРЕБУЄ ПОГОДЖЕННЯ ВЛАСНИКА
- [ ] **A.12** (додано 2026-07-28) Парсер для pump.fun (`buy`/`sell`/`create`) — саме там найбільше agent-активності і найбільше катастроф. **⚠️ Поза whitelisted-списком протоколів у CLAUDE.md** (Jupiter/Kamino + roadmap-відкриті Raydium/Orca/Drift/Marinade) → **не починати без явного «так» власника**
  ⏱ TBD (оцінка ~3 дні за аналогією з A.4/A.5, не валідована) · 📦 v0.5.8 · 🎯 *"Memecoin agents are where the wild things are. AgentScope now parses pump.fun buys and sells with real semantics — mint, SOL in, tokens out, bonding-curve state. Your degen agent is finally legible."*
  **Відкриті питання перед стартом:** (a) чи це наша цільова аудиторія, чи відволікання від «серйозних» yield/arb агентів; (b) чи є мейнтейнс-ризик — pump.fun міняє програму частіше за DEX-и.

**Cluster A total:** ~19 днів (+A.12 TBD), 12 micro-releases (v0.4.0 → v0.5.8). **A.1-A.11 закриті — весь security-зріз (A.9 + A.10 + A.11) у проді-коді. Лишилась тільки A.12 (потребує погодження власника).** Відкритий хвіст: SPL-леґ `outbound_transfer_drain` (потрібен мепінг token-account → owner у persist).

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

### C.9 — Weekly share-card (PNG)
- [ ] **C.9** (додано 2026-07-28) Кнопка «Share week» на agent-detail → рендерить картку 1200×630 (tx count, alerts fired, P&L delta, uptime streak, agent name) + copy-to-clipboard/download. Серверний рендер через SVG-string → PNG (без headless-браузера, без нових депів — reuse паттерн з [apps/api/src/routes/public-badge.ts](../apps/api/src/routes/public-badge.ts))
  ⏱ 1.5 дня · 📦 v0.8.2 · 🎯 *"Your agent's week, in one image. Tap 'Share week' and get a card with tx count, alerts, and P&L — sized for X. Your agent's track record, public if you want it."*
  **Файли:** `apps/api/src/routes/public-card.ts` (SVG → PNG) · `apps/dashboard/src/components/ShareWeekButton.tsx`
  **Обґрунтування (аналіз 2026-07-28):** у продукті **нуль user-generated acquisition surface**. C.6 (badge) — статичний і живе у README; це — recurring момент, який юзер хоче показати. Найдешевший growth-важіль у Cluster C.
  **Залежність:** public sanitization паттерн з C.0b/C.6. **Відкрите питання:** SVG→PNG без депа — треба перевірити, чи вистачає можливостей; якщо ні, віддавати SVG і не тягнути `resvg`/`sharp`.

### C.10 — Alert feedback («useful / noise»)
- [ ] **C.10** (додано 2026-07-28) Дві кнопки на кожному alert у фіді → `alerts.feedback` enum (`useful` / `noise` / null). Показувати noise-rate per rule у settings. Дає **реальні лейбли** замість чистої статистики і напряму годує D.1 auto-tuning
  ⏱ 1 день · 📦 v0.8.3 · 🎯 *"Every AgentScope alert now has a thumbs up/down. Tell us which ones were noise and your thresholds tune themselves against your labels, not our guesses. Alert fatigue is a product bug, not a user problem."*
  **Файли:** `packages/db` migration (`alerts.feedback`) · `apps/api/src/routes/alerts.ts` PATCH · `apps/dashboard/src/routes/alerts.tsx`
  **Залежність:** D.1 (auto-tuning) стає суттєво сильнішим з цими даними → **робити C.10 ПЕРЕД D.1**, щоб на момент D.1 уже назбиралась історія лейблів.

**Cluster C total:** ~16.5 днів, 12 micro-releases (v0.4.8 → v0.8.3)

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

> **Мета:** дати власнику (single-owner) платформний зріз метрик для звітності по гранту Solana Foundation Ukraine (M1=4 → M2=10 → M3=25 builders, deadline **2026-10-01** — увесь ланцюг M1/M2/M3 посунуто на два місяці, повідомлено власником 2026-07-31; деталі у [`GRANT-SF-UKRAINE-AWARDED.md §2`](GRANT-SF-UKRAINE-AWARDED.md)). На відміну від per-user dashboard (Privy + RLS по `user_id`), адмінка агрегує **across усіх користувачів**.
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

## Cluster G — Grant Ops / Acquisition & Retention 🔴 (додано 2026-07-28, deadline-driven)

> **Мета:** закрити структурну діру, виявлену в аналізі 2026-07-28 — **роудмап на 38 задач був на 100% інженерним, а KPI гранту вимірюється у «active builders»**. F.1/F.2 дали *перегляд* цифр; Cluster G дає *важелі*, які на ці цифри впливають, і *proof*, який здається спонсору.
>
> **Контекст на момент додавання (2026-07-28):** вікно M1 (4 білдери) закривалося 2026-08-01 — за 4 дні. [`GRANT-SF-UKRAINE-AWARDED.md §8`](GRANT-SF-UKRAINE-AWARDED.md) має 4 незакриті owner-actions, включно з «приватний трекер білдерів», який на 90% уже реалізований у admin builders-таблиці (F.2).
>
> **🔄 Оновлення 2026-07-31:** спонсор посунув **увесь** ланцюг на два місяці. Нові вікна: **M1 = серпень–вересень 2026** (deadline 2026-10-01), M2 = вересень–листопад 2026, M3 = грудень 2026 – лютий 2027. Наслідок для пріоритетів: **G.1 більше не аврал** — два додаткові місяці варто витратити на те, щоб білдерів *набрати* (G.2 + прямий аутріч), а не краще порахувати. G.1 робимо ближче до фактичної здачі; E.11 (backup) дорожчає, бо grant-proof дані живуть у Supabase без PITR на два місяці довше.
>
> **Визначення «active» — з гранту, не наше:** ≥1 tx за останні 14 днів **АБО** ≥1 доставлений alert за останні 30 днів. Registered ≠ active; трекаємо обидві цифри окремо (рішення з Cluster F).

### G.1 — Milestone proof exporter ✅ (2026-09-22)
- [x] **G.1** (2026-09-22 · 📦 v0.5.11 · `38b4eee`) `GET /api/admin/milestone-export` + картка «Milestone proof · grant definition» на `/admin`: три лічильники (**registered** = зовнішні юзери з ≥1 агентом; **connected · M1** = ≥1 агент з ≥1 tx будь-коли; **active · M2/M3** = tx за 14д ∨ *delivered* alert за 30д), анонімізована таблиця (screenshot-ready) і «Download CSV». Owner DIDs виключено з усього. `builderHash` = перші 12 hex `sha256(privy_did)` — стабільний між M1/M2/M3, без DID/email/user_id у payload (тест перевіряє явно). 8 тестів API (PGlite) + 5 тестів CSV-серіалізатора. На проді 2026-09-22: **31 registered / 29 connected / 21 active**, запит 0.55 с (перша версія з `count(*) filter` у тому ж CTE, що й `min/max`, — 4.4 с; розділення на bounded і index-only скани дало 8×).
  **Порядок змінено (2026-09-22):** G.1 витягнуто поперед G.2 за даними з проду — когорта G.2 (`lastSeenAt == null`, >7 днів) = **2 агенти**, з них 1 досяжний через Telegram, а `users.email` порожній у **всіх 33** юзерів (Privy wallet-login) — email-канал для G.2 не існує фізично. G.2 лишається, але після E.11.
  **Не зроблено свідомо:** наявні картки registered/active з *внутрішнім* визначенням (будь-яка tx або span) не змінено — F вирішив трекати обидва; test-акаунти поза owner DIDs не фільтруються (у схемі нема прапорця); server-side CSV не робили — серіалізація на клієнті дзеркалить E17 `tx-csv.ts`.
  **Файли:** [apps/api/src/routes/admin.ts](../apps/api/src/routes/admin.ts) (`getMilestoneExport`, експортований) · [apps/dashboard/src/lib/milestone-csv.ts](../apps/dashboard/src/lib/milestone-csv.ts) · [apps/dashboard/src/routes/admin.tsx](../apps/dashboard/src/routes/admin.tsx) (`MilestoneProofCard`)
  *Оригінальний опис:* Кнопка «Export milestone bundle» на `/admin` → (a) анонімізований CSV (`builder_hash`, `agents_count`, `first_tx_at`, `last_active_at`, `active_by_grant_definition`), (b) screenshot-ready вьюха без PII, (c) автопідрахунок registered vs active **саме за грантовим визначенням** (14д tx / 30д alert), а не за нашим внутрішнім. Зараз ці цифри збираються вручну під кожен milestone
  ⏱ 3-4 год · 📦 v0.5.2-admin · 🎯 *(internal/ops — опц. building-in-public твіт про грантовий трекер)*
  **Файли:** `apps/api/src/routes/admin.ts` (+`/milestone-export`) · `apps/dashboard/src/routes/admin.tsx` (кнопка + вьюха) · reuse `tx-csv.ts` serializer-паттерн з E17
  **Чому першим:** без цього кожне закриття milestone = ручний SQL + ручна анонімізація + ручний скріншот, і так тричі (M1/M2/M3). Один раз написати — тричі здати.

### G.2 — Re-activation nudge (registered але мовчить)
- [ ] **G.2** Cron: агент зареєстрований >7 днів тому, `lastSeenAt == null`, нуль tx → одноразовий Telegram/email власнику агента з лінком на onboarding-checklist + ingest-token. Максимум 2 нагадування (день 7 і день 21), потім тиша назавжди
  ⏱ 1 день · 📦 v0.5.3-admin · 🎯 *"Registered an agent and never wired it up? AgentScope now nudges you once — with your token and the three lines you need — instead of letting the account rot. Activation is our job, not yours."*
  **Файли:** `apps/ingestion/src/reactivation-nudge.ts` (новий cron) · reuse `packages/alerter` sender · `agents.nudged_at` migration
  **Обґрунтування:** C.0/C.0c (onboarding checklist) працюють **тільки якщо юзер зайде у дашборд**. Юзер, який зареєструвався і пішов, не побачить їх ніколи — а це саме та когорта, що відділяє registered від active, тобто саме та, яку рахує грант.
  **⚠️ Обмеження:** двічі і все. Ми продаємо алерти — стати джерелом спаму означає вбити довіру до власного каналу.

### G.3 — Weekly owner digest у Telegram
- [ ] **G.3** Щопонеділка 09:00 UTC — Telegram власнику: `+N builders / N active / N churned` за тиждень, DB size vs 500 MB, Helius credits %, ingest lag, топ-3 правила за спрацюваннями. Reuse admin-агрегатів (F.1) + `telegram-bot.ts`
  ⏱ 0.5 дня · 📦 v0.5.4-admin · 🎯 *(internal/ops)*
  **Файли:** `apps/ingestion/src/owner-digest.ts` (новий cron) · reuse `apps/api` admin SQL-хелпери (винести у `packages/db` якщо дублюються)
  **Обґрунтування:** ops-петля без відкривання дашборду. Помітити churn або наближення до storage-стелі через тиждень — дешево; через місяць — уже пізно.

**Cluster G total:** ~2 дні, 3 micro-releases (v0.5.2-admin → v0.5.4-admin). **G.1 закрито 2026-09-22** — M1 здається з нього; G.2 знижено в пріоритеті за прод-даними (див. G.1).

---

## Cluster H — Monetization 🟡 (додано 2026-07-28)

> **Мета:** дати платний шлях, якого зараз фізично не існує. Зараз `MAX_AGENTS_PER_USER=2` — це **глухий hard wall**: дашборд просто ховає кнопку «Add agent», користувач не бачить ні ціни, ні waitlist, ні пояснення.
>
> **Чому це у скоупі:** формулювання «through the free tier» / «using the free tier» **свідомо прибрано з M1 і KPI на вимогу спонсора** під час рев'ю ([`GRANT-SF-UKRAINE-AWARDED.md §2`](GRANT-SF-UKRAINE-AWARDED.md)). Тобто платні користувачі зараховуються у грантовий KPI нарівні з безкоштовними, і грант нас до free-only мотивації **не зобов'язує**.
>
> **Свідомо НЕ вирішуємо зараз:** ціну, тарифні межі, провайдера платежів. H.1 навмисно збирає сигнал **до** цих рішень.

### H.1 — Upgrade CTA + waitlist (без білінгу)
- [ ] **H.1** Замість мовчазного приховування Add-кнопки при досягненні cap — картка «Need more than 2 agents?» з коротким поясненням і формою waitlist (email + скільки агентів + який use-case → у БД, нотифікація власнику в Telegram). Жодних платежів, жодного провайдера
  ⏱ 2 год · 📦 v0.8.4 · 🎯 *(internal — не твітити до появи реальної пропозиції)*
  **Файли:** `apps/dashboard/src/routes/agents.tsx` (cap-стан) · `apps/api/src/routes/waitlist.ts` (новий) · `packages/db` migration `upgrade_waitlist`
  **Обґрунтування:** дає pipeline-сигнал за 2 години і **не вимагає жодного рішення про ціни**. Якщо за місяць нуль заявок — H.2 не потрібен, і ми зекономили тижні. Якщо заявки є — у нас є конкретні use-case'и, на яких будувати тариф.

### H.2 — Реальний білінг
- [ ] **H.2** Платіжний провайдер (Helio як Solana-native кандидат, Stripe як дефолт), тарифні межі, enforcement у API. **⚠️ Не починати без сигналу з H.1** і без явного рішення власника про модель
  ⏱ TBD · 📦 TBD · 🎯 *TBD*
  **Відкриті питання:** (a) Helio (Solana-native, «eat your own dogfood») vs Stripe (нудно, надійно, є в кожного); (b) чи вводити paid tier взагалі до 25 білдерів, чи це передчасна оптимізація; (c) податкова/юридична сторона — соло-розробник, USDG-грант, платні підписки — окрема тема поза інженерією.

**Cluster H total:** ~0.25 дня + TBD, 1-2 micro-releases. **H.1 — дешевий сигнал; H.2 — тільки за сигналом.**

---

## Cluster I — Docs & SEO surface 🟡 (додано 2026-07-28)

> **Мета:** побудувати поверхню, яку **грант прямо вимагає для M2**, а роудмап не покривав жодним пунктом. [`GRANT-SF-UKRAINE-AWARDED.md §4`](GRANT-SF-UKRAINE-AWARDED.md), «Required moves between M1 and M2»: *«One Mintlify-quality quickstart published»* + *«≥1 blog post that ranks for a Solana-agent observability keyword»*.
>
> **Поточний стан (перевірено 2026-07-28):** [`apps/landing/src/pages`](../apps/landing/src/pages) містить рівно два файли — `index.astro` і `quickstart.astro`. Блогу нема. Docs-сайту нема. 13 правил детектора **ніде не задокументовані для користувача** — тільки в коді й у цьому роудмапі.
>
> **Zero нових депів:** Astro 4.16 вже стоїть, content collections і RSS — вбудовані.

### I.1 — Blog на Astro content collections
- [ ] **I.1** `apps/landing/src/pages/blog/` + content collection (`src/content/blog/*.md`), список, RSS-фід, OG-картинки, канонічні URL. Перший пост — той самий, що вимагає M2 (кандидат: «How we parse 7 Solana protocols for agent observability» або грант-ретроспектива)
  ⏱ 1.5 дня · 📦 v0.6.6 · 🎯 *"AgentScope has a blog now. First post: how we decode Jupiter, Raydium, Orca, Drift, Kamino, Marinade and SPL from raw transactions — the unglamorous half of agent observability."*
  **Файли:** `apps/landing/src/content/config.ts` · `apps/landing/src/pages/blog/[...slug].astro` + `index.astro` · `apps/landing/src/pages/rss.xml.ts`

### I.2 — /docs з сайдбаром + rules reference
- [ ] **I.2** Розширити одинокий `quickstart.astro` у повноцінний `/docs` з навігацією: Getting started (L0 REST / L1 OTel / L2 SDK), **Alert rules reference — усі 13 правил з порогами, дефолтами й прикладами payload'ів**, Self-host (синергія з B.7), API reference (лінк на C.8 Scalar)
  ⏱ 2 дні · 📦 v0.6.7 · 🎯 *"Real docs shipped. Every alert rule documented — what fires it, what the default threshold is, what the payload looks like. No more reading our source to find out why you got pinged."*
  **Файли:** `apps/landing/src/pages/docs/` · `apps/landing/src/components/DocsSidebar.astro` · джерело правди для rules — `packages/shared/src/types.ts` + `format-alert.ts`
  **⚠️ Ризик дрейфу:** rules reference писаний руками розійдеться з кодом. Розглянути генерацію сторінки з `AlertRuleName` + дефолтів у білді.

### I.3 — llms.txt + структуровані дані
- [ ] **I.3** `/llms.txt` і `/llms-full.txt` на landing (стандарт для LLM-агентів, що читають сайти) + JSON-LD `SoftwareApplication` на index + `Article` на блог-постах
  ⏱ 0.5 дня · 📦 v0.6.8 · 🎯 *"AgentScope now ships llms.txt. We build tools for AI agents — the least we can do is make our own docs machine-readable for the agents that go looking."*
  **Файли:** `apps/landing/public/llms.txt` (або generated route) · `apps/landing/src/layouts/` JSON-LD
  **Обґрунтування:** наша аудиторія — люди, які будують агентів, і дедалі частіше **самі агенти**, що шукають інструменти. Дешево, а наратив ідеально збігається з продуктом.

**Cluster I total:** ~4 дні, 3 micro-releases (v0.6.6 → v0.6.8). **I.1 + I.2 — прямі вимоги гранту для M2.**

---

## Загальна оцінка

| Cluster | Releases | Tasks | Days | Twit moments |
|---|---|---|---|---|
| **E (Infra Hardening + Deploy-safety 🔴 PRIORITY)** | **v0.4.3 → v0.5.4-infra** | **10** | **~7** | **5** |
| A (Detection + Parsers) | v0.4.0 → v0.5.8 | 12 | ~19 (+TBD) | 12 |
| B (Notifications + DX) | v0.6.0 → v0.7.1 | 8 | ~11 | 8 |
| **C (Dashboard UX + Growth 🔴 C.0/C.0b priority)** | **v0.4.8 → v0.8.3** | **12** | **~16.5** | **12** |
| D (AI/LLM features) | v0.9.0 → v0.9.3 | 4 | ~12 | 4 |
| **F (Grant Ops / Admin) 🟢** | **v0.5.0-admin → v0.5.1-admin** | **2** | **~3** | **1** |
| **G (Grant Acquisition & Retention 🔴 NEW)** | **v0.5.2-admin → v0.5.4-admin** | **3** | **~2** | **1** |
| **H (Monetization 🟡 NEW)** | **v0.8.4 → TBD** | **2** | **~0.25 (+TBD)** | **0** |
| **I (Docs & SEO 🟡 NEW)** | **v0.6.6 → v0.6.8** | **3** | **~4** | **3** |
| **Total** | **~52 releases** | **56 tasks** | **~75 days (+TBD)** | **~46 tweet-moments** |

**Каденс:** один micro-release на тиждень при солірному vibe-coding ритмі. Це не обіцянка, а ceiling.

**Ревізія 2026-07-28:** додано 18 задач (A.9-A.12, E.8-E.11, C.9-C.10, кластери G/H/I). Приводом був аналіз, що виявив три системні діри: (1) роудмап на 38 задач був **100% інженерним**, тоді як KPI гранту — «active builders»; (2) 13 правил детектора не покривали **жодного security-вектора**, хоча саме через них агентські гаманці помирають; (3) поверхня, яку грант **прямо вимагає для M2** (docs + blog), не мала жодного пункту.

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

**Phase 2 (parser surge):** A.4 ✅ → A.5 ✅ → A.7 ✅ → A.6 ✅ — **ЗАКРИТА**
- 4 парсери підряд. A.6 (Drift perps) закрив фазу: скоуп звужено до класичних agent-order інструкцій (Drift order-flow мігрував на Swift; keeper/fill-інструкції поза скоупом). Далі — Phase 3 (DX + self-host): B.7 → B.6 → B.8.

**Phase 2.5 (🟠 GRANT-DRIVEN, вставлено 2026-07-28; перевпорядковано 2026-07-31 і 2026-09-22):** G.1 ✅ → E.11 → G.2 / аутріч
- **🔄 2026-09-22:** G.1 закрито першим — прод-дані показали, що когорта G.2 це 2 агенти (1 досяжний), а M1 уже перевиконано (21 active проти 4). Далі E.11 (backup) → G.2.
- **🔄 Новий порядок після продовження дедлайну (M1 тепер до 2026-10-01):** два додаткові місяці — це час *набрати* білдерів, а не краще їх порахувати. **G.2 + прямий аутріч** ідуть першими: без 4 білдерів G.1 експортує порожній CSV. **E.11** (backup) — другим: proof-дані живуть у Supabase без PITR на два місяці довше, це єдиний пункт роадмапу без стелі збитку. **G.1** (~4 год) — ближче до фактичної здачі, він нікуди не втече і лишається тричі окупним (M1/M2/M3).
- **Первинне обґрунтування (2026-07-28, дедлайн 2026-08-01):** G.1 ішов першим саме через 4 дні до закриття вікна M1.
- **E.11 (backup) сюди ж:** грантові proof-дані живуть у тій самій Supabase-БД без PITR. Втратити їх напередодні звітності — єдиний ризик у роудмапі без стелі збитку.

**Phase 3 (DX + self-host):** B.7 → B.6 → B.8
- Спрямовано на self-host story для open-source momentum.

**Phase 3.5 (M2-вимоги гранту):** I.1 → I.2 → H.1 → E.8 → E.9
- I.1+I.2 — **буквальні вимоги** «Required moves between M1 and M2» з гранту (quickstart-рівня docs + блог-пост). I.2 добре лягає одразу після B.7 — self-host-сторінка пишеться, поки контекст свіжий. H.1 (2 год) запускає збір сигналу про попит на платний тариф якнайраніше — цінність росте з часом очікування. E.8/E.9 — дешева гігієна, добре йде «між важким».

**Phase 4 (Growth surface):** C.9 → C.7 → C.8 → E.10
- Marketing-driven. C.9 (share-card) поперед C.7 — дешевша і дає recurring user-generated поверхню, тоді як widget одноразовий. C.7 залежить від C.0b (public read routes).

**Phase 4.5 (Security rules):** A.9 ✅ → A.11 ✅ → A.10 ✅
- Порядок за співвідношенням цінність/вартість: A.9 і A.11 переважно reuse наявних даних, A.10 потребує нового SPL Token парсера. Разом закривають категорію «агента дренять», якої в детекторі не було зовсім.
- **A.9 закрито 2026-07-28** (v0.5.5) — витягнуто вперед на прохання власника, поза чергою Phase 2.5. A.11 успадкувала від нього cold-start abstain + винесений lamport-хелпер.
- **A.11 закрито 2026-07-31** (v0.5.7) — але **лише SOL-леґ**: SPL-частина впиралась у SPL Token парсер, що й A.10.
- **A.10 закрито 2026-08-11** (v0.5.8) — парсер + правило. Очікування «дві дірки за одну ціну» справдилось лише наполовину: approve-вектор закрито, а SPL-леґ A.11 — ні. Парсер дає `destination`, але це **токен-акаунт**, і без мепінгу account → owner (persist його не зберігає) немає counterparty, якого можна судити. Залишається окремим follow-up у хвості кластера.

**Phase 5 (AI moat):** C.10 → D.1 → D.2 → D.3 → D.4
- **C.10 навмисно поперед D.1:** auto-tuning на реальних «useful/noise» лейблах суттєво сильніший за чисту статистику, а лейблам треба час назбиратись. Решта — найдорожчі за часом і потребують Claude API integration.

**Залишок (B.2, B.3, B.4, C.1, C.2, C.3, C.4, C.5, G.3, I.3):** інтерліфувати між phases як "відпочинок від важких задач".

**Потребують явного рішення власника перед стартом:** A.12 (pump.fun — поза whitelisted-протоколами у CLAUDE.md), H.2 (білінг — модель, провайдер, юридична сторона).

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
| v0.5.3 | 2026-07-07 | A.7 (Marinade liquid staking parser) | ✅ released |
| v0.5.2 | 2026-07-14 | A.6 (Drift v2 perps parser) | ✅ released |
| v0.5.5 | 2026-07-28 | A.9 (unknown_program_interaction rule) | ✅ released |
| v0.5.6 | 2026-07-31 | E.9 (tag → Release automation) + E.12 (schema-drift checker) | ✅ released |
| v0.5.7 | 2026-07-31 | A.11 (outbound_transfer_drain rule) | ✅ released |
| v0.5.8 | 2026-08-11 | A.10 (SPL Token parser + token_approval_anomaly) | ✅ released |
| v0.5.9 | 2026-08-22 | E.13 (ingestion heartbeat + edge-triggered uptime alert) | ✅ released |
| v0.5.10 | 2026-09-22 | E.14 (fetch body drain + memory signals) + E.15 (self-kill watchdog + cron deadline) | ✅ released |
| v0.5.11 | 2026-09-22 | G.1 (milestone proof export by grant definitions) | ✅ released |
| … | … | … | … |

---

## Maintenance items (не roadmap, але треба тримати в голові)

- **Supabase free tier 500 MB cap** — `agent_transactions` партиціонована помісячно (RLS-enabled, P.11), а `apps/ingestion/src/partition-maintenance.ts` (2026-06) тепер **автоматично розкочує партиції вперед** (`PARTITION_MONTHS_AHEAD`, default 3) — це закрило приховану діру: initial-міграція мала партиції лише до 2026-09, тож після 1 жовтня tx падали б у DEFAULT-партицію (рівно вікно гранту M3). TTL-drop старих місяців реалізований, але **opt-in** через `TX_RETENTION_MONTHS` (default 0 = вимкнено — видалення історії tx це продуктове рішення). Увімкнути (напр. `3`), коли prod-DB наближається до ~350-400 MB. **Точна модель місткості (до скількох агентів витягне 500 MB, формули, важелі) — [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md); реалізаційні задачі — Cluster E вище.** **Neon як альтернатива відхилена (2026-06-01):** Neon free = ті самі 0.5 GB + 100 CU-hr/міс cap, ворожий до нашого 24/7-writer'а (засинання неможливе → ~182 CU-hr > 100). Наступний платний крок при перерості free = **Supabase Pro $25/mo (8 GB, без RLS-міграції)**, не Neon.
- **Helius free tier RPC limits** — Helius free = 10 RPS / 1M credits/mo. Гарячий кредитний насос = `getBlock` у slot-neighbour (A.1 sandwich). **Alchemy free — drop-in fallback** (25 RPS / 30M CU): код provider-agnostic (стандартний WS + JSON-RPC, Helius-gRPC unused), тож перехід = свап `SOLANA_RPC_URL`+`SOLANA_WS_URL`. Опція zero-cost: streaming на Helius + getBlock на Alchemy = подвоєний free-headroom. Pro ($199/mo) лише коли обидва free впруться. **УВАГА (2026-06-01): справжня поточна стеля — НЕ rate, а credits, і впирається на ~23 агентах через getBalance-cron (E.1 fix критичний). Деталі — [`INFRA-CAPACITY.md`](INFRA-CAPACITY.md) + Cluster E.** До фіксів — стеля ~23 агенти, не «не оптимізуємо передчасно».
- **Railway free credits ($5/mo)** — поточне споживання ~$2/mo (api + ingestion sidecar). Запас до 10× users.
- **npm package versions** — `@agentscopehq/elizaos-plugin@0.1.0-alpha.0` і `@agentscopehq/agent-kit-sdk@0.1.0-alpha.0` живуть як alpha. Перший stable `1.0.0` — коли A.1-A.3 (нові правила) і B.1-B.2 (Discord/Slack) виходять, тобто десь біля v0.6.x release.
- **Prod migrations** — будь-яка нова DB migration потребує накочування на Supabase prod ПЕРЕД деплоєм нової версії api/ingestion. **Порядок (переписано після інциденту 2026-07-31, див. E.12):**
  1. Виконати SQL-файл міграції у Supabase SQL-редакторі. **НЕ `db:push`** — журнал drizzle обривається на `0009`, тож push не знає про партиції, RLS-політики та enum-ALTER'и з `0010`+ і пропонує їх знести. `db:migrate` їх теж не бачить.
  2. `pnpm --filter @agentscope/scripts check-schema-drift` — має вийти з кодом 0. Це єдина перевірка, що міграція справді доїхала; покладатись на пам'ять не можна, бо саме так шість міграцій і загубились.
  3. Тільки після зеленого чекера — деплой api, потім ingestion.

---

## Як я (Claude) маю використовувати цей файл

При наступних сесіях:
1. Якщо власник просить "що далі робити?" — пропоную наступний task з рекомендованого порядку вище.
2. Якщо власник просить "напиши твіт" — використовую `🎯` поле як основу, дотримуючись `docs/MARKETING.md §12` протоколу.
3. Коли task закривається — оновлюю checkbox `[ ]` → `[x]`, додаю commit hash + date, апдейчу `Лог релізів`. Перед `/clear` — комітимо.
4. Якщо new ideas вилазять у розмові — додаю їх у відповідний Cluster з `[ ]` маркером і `⏱ TBD`, не починаю роботу до явного погодження власника.
