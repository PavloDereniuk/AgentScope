# AgentScope — Claude Code контекст

**Що це:** Datadog для Solana AI агентів. Платформа observability для on-chain AI агентів — реєстр, парсинг tx, OTel reasoning logs, rule-based аномалії, алерти.

**Дедлайн:** 2026-05-11 (Colosseum Frontier, AI track). **Сольний vibe-coding.**

## Воркфлоу
**ОБОВ'ЯЗКОВО** дотримуватись `../Workspace/docs/PROJECT-BOOTSTRAP.md`. На початку кожної сесії читати: `CLAUDE.md` → `docs/TASKS.md` → `docs/SCRATCHPAD.md`. Перед `/clear` — оновити TASKS+SCRATCHPAD, закомітити.

## Стек (фіксований у `docs/PLAN.md`)
- **Monorepo:** pnpm 9 + Turborepo 2.3, Node 24
- **Lang:** TypeScript 5.6 strict, Biome 1.9 (lint+format), Vitest 2.1
- **Backend:** Hono 4.6 + Drizzle 0.36 + postgres + Yellowstone gRPC + @solana/web3.js + Anchor
- **Frontend:** React 18 + Vite 5 + Tailwind + shadcn/ui + Recharts + Privy + react-query
- **Landing:** Astro 4.16 (окремий Vercel deploy)
- **Telemetry:** OpenTelemetry OTLP/HTTP
- **Alerting:** Telegram (MVP), Discord/Slack — post-MVP
- **DB:** Supabase Postgres free, RLS per user_id
- **Hosting:** Railway (api/ingestion/cron), Vercel (dashboard/landing), Supabase (db). Все free.

## Структура
```
apps/{api,ingestion,dashboard,landing}
packages/{db,parser,detector,alerter,elizaos-plugin,agent-kit-sdk,shared,config}
infra/  scripts/  .github/workflows/  docs/{SPEC,PLAN,TASKS,SCRATCHPAD}.md
```

## Жорсткі правила
- **TS strict, без `any`.** Biome enforce.
- **TDD strict** для `packages/parser` та `packages/detector`. Інше — тести разом з кодом.
- **Zod** на всіх API boundaries (`@hono/zod-validator`).
- **Conventional commits.** Один комміт = одна задача з `docs/TASKS.md`.
- **НЕ комітати** секрети, `.env`, keypairs, `*.keypair.json`. `pre-commit` enforce.
- **НЕ деплоювати** на mainnet без явного дозволу. MVP = devnet.
- **НЕ додавати залежності** після Тижня 1 без обґрунтування у комміті.
- **НЕ розширювати скоуп.** Все що поза `docs/SPEC.md` §7 (out-of-scope) — відмова.
- **Парсимо ТІЛЬКИ:** Jupiter v6 + Kamino Lend. Інші протоколи — post-MVP.
- **Мова коментарів та доків:** англійська. Спілкування зі мною — українська.

## Команди
- `pnpm dev` — все паралельно через turbo
- `pnpm test` / `pnpm test:watch`
- `pnpm lint` / `pnpm lint:fix`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @agentscope/db db:generate|db:migrate|db:push`

## Перед коммітом
`pnpm lint && pnpm typecheck && pnpm test` — все має бути зеленим.

## Корисні файли
- `docs/SPEC.md` — продуктова специфікація v1
- `docs/PLAN.md` — технічний план (стек, схема, API, security)
- `docs/TASKS.md` — атомарні задачі з чекбоксами
- `docs/SCRATCHPAD.md` — нотатки між сесіями
- `agentscope-project.md` — оригінальна ідея/pitch (background)
