# Scratchpad

Робочі нотатки між сесіями. Перед `/clear` оновлювати тут: що зроблено, де зупинились, відомі проблеми, наступні кроки.

---

## 2026-04-07 — Bootstrap

### Зроблено
- Phase 1: `docs/SPEC.md` v1 — фіналізовано, всі 5 відкритих питань закриті
- Phase 2: `docs/PLAN.md` написано (стек, архітектура, схема, API, security)
- Phase 2: ініціалізована monorepo структура (pnpm 9.15.0 + Turborepo 2.3)
  - root: package.json, pnpm-workspace.yaml, turbo.json, biome.json, tsconfig.base.json, tsconfig.json
  - .gitignore, .env.example, .nvmrc
  - CLAUDE.md (≤60 рядків)
  - 4 apps + 8 packages з stub package.json
  - .github/workflows/ci.yml
  - infra/docker-compose.yml (local Postgres)
  - README.md

### Де зупинились
- Очікую затвердження Фази 2 від користувача
- Наступне: Phase 3 — `docs/TASKS.md` (декомпозиція PLAN на атомарні задачі)

### Відомі проблеми
- Жодних поки

### Наступні кроки
1. Затвердити Phase 2
2. Написати TASKS.md з епіками + атомарними задачами + залежностями
3. Перейти до Phase 4 (TDD імплементація по черзі)
