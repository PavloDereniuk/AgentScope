---
name: superteam-earn
description: "Парсить завдання з Superteam Earn (bounties, projects, hackathons). Фільтрує UA + Global, оцінює 5 суддями, зберігає Excel з архівацією. Triggers: '/superteam-earn', 'superteam earn', 'superteam завдання', 'суперкоманда'."
user-invocable: true
argument-hint: "[--type bounty|project|hackathon|all] [--min-reward N] [--max-reward N] [--deadline-within Nd] [--no-judges] [--verbose]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash(node *)
  - Bash(mkdir *)
  - Bash(mv *)
  - Bash(cp *)
  - WebFetch
  - Agent
---

# Superteam Earn — Task Parser & Evaluator

**НІКОЛИ не вигадуй завдання.** Кожен елемент — з реального API або WebFetch.
**ВСІ дані в Excel та коментарі суддів — українською мовою.** Назви проєктів, технологій — оригінальною.

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **RUN_TS**: !`node -e "const d=new Date();console.log(d.toISOString().slice(0,10)+'_'+d.toTimeString().slice(0,5).replace(':','-'))"`
- **DATA_DIR**: `{WORKDIR}/data/superteam-earn`
- **SCRIPTS**: `{WORKDIR}/scripts`
- **OUTPUT_EXCEL**: `{WORKDIR}/output/excel/superteam-earn`
- **STATE_FILE**: `{DATA_DIR}/state.json`

## Parameters

Parse from `$ARGUMENTS`:

| Param | Default | Notes |
|-------|---------|-------|
| `--type` | `all` | `bounty` `project` `hackathon` `all` |
| `--min-reward` | `0` | USD threshold |
| `--max-reward` | off | USD ceiling |
| `--deadline-within` | off | days, e.g. `7d` |
| `--no-judges` | off | skip judge evaluation, only fetch & display |
| `--verbose` | off | show extra debug info |

---

## Constants

```
API_BASE = "https://superteam.fun/api/listings/"
LISTING_URL_PREFIX = "https://superteam.fun/earn/listing/"
UA_CHAPTER_ID = "469534d0-2f62-4438-bbf7-7ea64ff4ca01"
PAGE_SIZE = 100
```

---

## Step 0: Init

1. Create directories:
```bash
node -e "const fs=require('fs');['data/superteam-earn/archive','output/excel/superteam-earn'].forEach(d=>fs.mkdirSync(d,{recursive:true}))"
```

2. Read `STATE_FILE`. If missing, create:
```json
{
  "runs": [],
  "lastRunDate": null,
  "knownIds": []
}
```

3. Determine run mode:
   - If `state.lastRunDate === null` → **FIRST RUN** (fetch all active)
   - Else → **UPDATE RUN** (find only new since last run)

4. Check ExcelJS availability: `node -e "require('exceljs')"`. Set `HAS_EXCEL`.

PRINT:
```
SUPERTEAM EARN — {TODAY}
Режим: {FIRST RUN / UPDATE (last: YYYY-MM-DD)}
Тип: {TYPE} | Мін. нагорода: ${MIN_REWARD}
```

---

## Step 1: Fetch Listings from API

### 1a. Paginated API fetch

Fetch ALL active listings by paginating:

```
Page 1: WebFetch {API_BASE}?take={PAGE_SIZE}&skip=0
Page 2: WebFetch {API_BASE}?take={PAGE_SIZE}&skip=100
...continue until results.length < PAGE_SIZE
```

For each WebFetch, extract JSON array. Each listing object has:
```json
{
  "id": "uuid",
  "title": "...",
  "slug": "...",
  "type": "bounty|project|hackathon",
  "rewardAmount": 1000,
  "token": "USDC|USDG",
  "deadline": "2026-04-06T23:59:59.000Z",
  "status": "OPEN",
  "compensationType": "fixed|range|variable",
  "minRewardAsk": null,
  "maxRewardAsk": null,
  "isFeatured": false,
  "agentAccess": "HUMAN_ONLY|AGENT_ALLOWED|AGENT_ONLY",
  "_count": { "Comments": 10, "Submission": 26 },
  "sponsor": {
    "name": "...",
    "slug": "...",
    "logo": "https://...",
    "isVerified": false,
    "chapter": "uuid-or-null"
  }
}
```

### 1b. Filter by region

Keep ONLY listings where:
- `sponsor.chapter === "{UA_CHAPTER_ID}"` (Superteam Ukraine) **OR**
- `sponsor.chapter === null` (Global — no chapter affiliation)

Mark each item with `region`:
- `"ukraine"` if chapter === UA_CHAPTER_ID
- `"global"` if chapter === null

### 1c. Filter by status & deadline

- Keep only `status === "OPEN"`
- Keep only `deadline > NOW` (deadline not expired)
- If `--type` set → filter by `type`
- If `--min-reward` → filter `rewardAmount >= min`
- If `--max-reward` → filter `rewardAmount <= max`
- If `--deadline-within Nd` → filter `deadline <= NOW + N days`

### 1d. Delta detection (UPDATE RUN only)

If this is an UPDATE RUN:
- Compare fetched listing IDs with `state.knownIds`
- Split into:
  - `newListings` — IDs NOT in knownIds (these are NEW)
  - `stillActive` — IDs in both (still active from previous run)
- **Only process `newListings`** for judge evaluation and Excel
- If `newListings.length === 0` → PRINT `Нових завдань не знайдено з {lastRunDate}.` → skip to Step 5 (update state)

### 1e. Construct full item objects

For each listing, build:
```json
{
  "id": "...",
  "name": "{title}",
  "url": "{LISTING_URL_PREFIX}{slug}",
  "type": "{type}",
  "reward": "{rewardAmount} {token}",
  "rewardUSD": "{rewardAmount}",
  "deadline": "YYYY-MM-DD",
  "sponsor": "{sponsor.name}",
  "region": "ukraine|global",
  "submissions": "{_count.Submission}",
  "comments": "{_count.Comments}",
  "compensationType": "...",
  "isFeatured": true/false,
  "agentAccess": "...",
  "description": ""
}
```

PRINT:
```
Знайдено: {TOTAL} завдань ({UA_COUNT} UA + {GLOBAL_COUNT} Global)
{Якщо UPDATE: "Нових: {NEW_COUNT} з {LAST_RUN_DATE}"}
Bounties: {N} | Projects: {N} | Hackathons: {N}
```

---

## Step 2: Enrich Top Listings

For the top 10 listings (sorted by rewardAmount descending), fetch listing detail pages to get descriptions:

```
WebFetch {LISTING_URL_PREFIX}{slug}
```

Extract from page:
- Full description / task requirements
- Skills/technologies required
- Submission requirements
- Eligibility details
- Prize breakdown (if multiple winners)

Update the item's `description` field with a concise summary (max 200 chars).

If WebFetch fails (404, timeout) → keep item with empty description, mark `enriched: false`.

PRINT: `Збагачено {N}/{M} завдань деталями`

---

## Step 3: Judge Evaluation (skip if --no-judges)

Launch **5 agents simultaneously** (all in single message, model: "sonnet"). Each agent receives ALL items and scores them on ONE criterion.

### Scoring weights

| Criterion | Weight | Key |
|-----------|--------|-----|
| Achievability | 0.30 | achievability |
| ROI | 0.25 | roi |
| Claude Code Fit | 0.20 | claude_fit |
| Competition | 0.15 | competition |
| Strategic Value | 0.10 | strategic |

**Formula:** `total = achievability*0.30 + roi*0.25 + claude_fit*0.20 + competition*0.15 + strategic*0.10`

### Judge 1: Achievability (weight: 0.30)

---BEGIN JUDGE 1 PROMPT---
Ти експерт з оцінки досяжності завдань. Оціни кожне завдання за шкалою 1-10.

**Критерій — ДОСЯЖНІСТЬ:**
- Чи може досвідчений JS/Python/Solidity розробник з Claude Code виконати це за 1-7 днів?
- Наскільки чітко визначені deliverables?
- Чи є конкретний scope або вимоги розмиті?
- Чи потребує специфічних навичок (дизайн, відео, копірайтинг)? Якщо так — знижуй оцінку.
- Чи потребує фізичної присутності або KYC?

10 = чіткий deliverable, 1-3 дні з Claude Code, конкретний scope
7 = визначений scope, ~1 тиждень роботи
5 = розмитий scope, потребує дослідження
3 = вимагає специфічних навичок (дизайн, відео)
1 = нереалістично виконати за тиждень або потребує фізичної присутності

**ЗАВДАННЯ ДЛЯ ОЦІНКИ:**
{ITEMS_JSON}

**Поверни ТОЧНО такий JSON (без markdown обгортки):**
[{"id": "listing-uuid", "score": 7, "justification": "1-2 речення пояснення українською"}]

Поверни оцінки для ВСІХ завдань. Пиши justification українською.
---END JUDGE 1 PROMPT---

### Judge 2: ROI (weight: 0.25)

---BEGIN JUDGE 2 PROMPT---
Ти експерт з оцінки ROI (повернення інвестицій часу). Оціни кожне завдання за шкалою 1-10.

**Критерій — ROI ($/год):**
- Яка ефективна $/год при виконанні з Claude Code (враховуй 4-8x прискорення)?
- Чи адекватна нагорода відносно обсягу роботи?
- Чи є приховані витрати (інфраструктура, тестнет токени)?
- Тип компенсації: fixed краще за variable/range

Орієнтири $/год (з урахуванням Claude Code speedup):
10 = $100+/год ефективно
7 = $30-100/год
5 = $15-30/год
3 = $5-15/год
1 = <$5/год або нагорода невизначена (TBD, points)

**Sweet spot нагороди:**
- $200-$2,000 → найкращий баланс зусилля/нагороди (+1 бонус)
- <$100 → занадто мало для серйозної роботи (-1)
- >$10,000 → зазвичай висока конкуренція (-1)

**ЗАВДАННЯ ДЛЯ ОЦІНКИ:**
{ITEMS_JSON}

**Поверни ТОЧНО такий JSON (без markdown обгортки):**
[{"id": "listing-uuid", "score": 7, "justification": "1-2 речення пояснення українською"}]

Поверни оцінки для ВСІХ завдань. Пиши justification українською.
---END JUDGE 2 PROMPT---

### Judge 3: Claude Code Fit (weight: 0.20)

---BEGIN JUDGE 3 PROMPT---
Ти експерт з оцінки відповідності завдань для виконання з AI-інструментами. Оціни кожне завдання за шкалою 1-10.

**Критерій — CLAUDE CODE FIT:**
- Наскільки завдання підходить для виконання з Claude Code?
- Чи це програмування (smart contracts, API, SDK, tools, dashboards)?
- Чи потребує креативності (дизайн, відео, контент)?
- Чи відповідає стеку: JS, TypeScript, Python, Solidity, Rust, Web3?

10 = чисте програмування (smart contracts, API, SDK, інструменти, інтеграції)
8 = в основному код + трохи документації
6 = код + значна дослідницька частина
4 = контент + трохи коду (threads, articles з технічним аналізом)
2 = чистий контент (tweets, відео, дизайн)
1 = фізична присутність, KYC, або повністю нетехнічне

**ЗАВДАННЯ ДЛЯ ОЦІНКИ:**
{ITEMS_JSON}

**Поверни ТОЧНО такий JSON (без markdown обгортки):**
[{"id": "listing-uuid", "score": 7, "justification": "1-2 речення пояснення українською"}]

Поверни оцінки для ВСІХ завдань. Пиши justification українською.
---END JUDGE 3 PROMPT---

### Judge 4: Competition Level (weight: 0.15)

---BEGIN JUDGE 4 PROMPT---
Ти експерт з аналізу конкуренції. Оціни кожне завдання за шкалою 1-10.

**Критерій — РІВЕНЬ КОНКУРЕНЦІЇ (обернений — менше конкуренції = вища оцінка):**
- Скільки submissions вже подано? (менше = краще)
- Чи обмежене завдання по регіону (Ukraine-only = менше конкуренції)?
- Наскільки до дедлайну? (менше часу = менше нових конкурентів)
- Чи потребує специалізованих навичок (менше конкурентів)?

Орієнтири по submissions:
10 = 0-3 submissions, регіональне обмеження
8 = 3-10 submissions
6 = 10-25 submissions
4 = 25-50 submissions
2 = 50-100 submissions
1 = 100+ submissions або хакатон з тисячами учасників

**Бонуси:**
- Ukraine-only listing → +1 (менша аудиторія)
- Дедлайн через 3-7 днів → +1 (менше часу для нових)
- Технічно складне → +1 (менше кваліфікованих)

**ЗАВДАННЯ ДЛЯ ОЦІНКИ:**
{ITEMS_JSON}

**Поверни ТОЧНО такий JSON (без markdown обгортки):**
[{"id": "listing-uuid", "score": 7, "justification": "1-2 речення пояснення українською"}]

Поверни оцінки для ВСІХ завдань. Пиши justification українською.
---END JUDGE 4 PROMPT---

### Judge 5: Strategic Value (weight: 0.10)

---BEGIN JUDGE 5 PROMPT---
Ти експерт зі стратегічної цінності можливостей. Оціни кожне завдання за шкалою 1-10.

**Критерій — СТРАТЕГІЧНА ЦІННІСТЬ:**
- Чи будує це репутацію в екосистемі Solana/Superteam?
- Чи може привести до повторних замовлень від спонсора?
- Чи розвиває цінні навички (Solana dev, smart contracts)?
- Чи дає портфоліо-кейс?
- Чи є спонсор відомим/верифікованим?

10 = великий верифікований спонсор, будує репутацію, веде до повторних замовлень
7 = відомий спонсор, гарний портфоліо-кейс
5 = середній спонсор, деяка стратегічна цінність
3 = невідомий спонсор, одноразове завдання
1 = нульова стратегічна цінність

**Бонуси:**
- Superteam Ukraine спонсор → +1 (локальна мережа)
- Verified спонсор → +1
- Featured listing → +1
- Розробка (не контент) → +1 (портфоліо)

**ЗАВДАННЯ ДЛЯ ОЦІНКИ:**
{ITEMS_JSON}

**Поверни ТОЧНО такий JSON (без markdown обгортки):**
[{"id": "listing-uuid", "score": 7, "justification": "1-2 речення пояснення українською"}]

Поверни оцінки для ВСІХ завдань. Пиши justification українською.
---END JUDGE 5 PROMPT---

### Parsing judge responses

For each judge response:
1. Try `JSON.parse()` on the response text
2. If fails → extract between first `[` and last `]`, then `JSON.parse()`
3. If still fails → score all items as 5 for that criterion with note "judge parse error"

Match scores by `id` field to listings.

---

## Step 4: Aggregate, Rank & Report

### 4a. Compute final scores

For each item:
```
total = achievability*0.30 + roi*0.25 + claude_fit*0.20 + competition*0.15 + strategic*0.10
```
Sort by `total` descending. Assign `rank` 1-N.

### 4b. Generate Excel

Write items JSON to `{DATA_DIR}/report-data.json`, then:
```bash
node {SCRIPTS}/generate-superteam-excel.mjs {DATA_DIR}/report-data.json "{OUTPUT_EXCEL}/earn_{RUN_TS}.xlsx"
```

If `HAS_EXCEL` is false → generate CSV fallback:
```bash
node {SCRIPTS}/generate-superteam-excel.mjs {DATA_DIR}/report-data.json "{OUTPUT_EXCEL}/earn_{RUN_TS}.csv" --csv
```

Clean up temp data:
```bash
node -e "try{require('fs').unlinkSync('data/superteam-earn/report-data.json')}catch{}"
```

### 4d. Terminal output

```
=====================================================
  SUPERTEAM EARN — {TODAY}
  {FIRST RUN / UPDATE (нових: N з LAST_DATE)}
  Знайдено: {TOTAL} | UA: {UA} | Global: {GLOBAL}
=====================================================

ТОП РЕЗУЛЬТАТИ:

1. {Name} [{UA/Global}] [{bounty/project/hackathon}]
   ${rewardAmount} {token} | дедлайн {YYYY-MM-DD} | {submissions} submissions
   {sponsor.name} {verified ? "✓" : ""}
   Ach:{X} ROI:{X} CC:{X} Comp:{X} Str:{X} -> TOTAL: {XX}
   {url}
   {description — 1 line}

...

=====================================================
Звіт: {OUTPUT_EXCEL}/earn_{RUN_TS}.xlsx
=====================================================
```

For top 3 items with total >= 6.0, show action hint:
```
РЕКОМЕНДАЦІЇ:
1. {Name} — {1 речення чому варто братися + перший крок}
```

---

## Step 5: Update State

Read `STATE_FILE`, update:

```json
{
  "runs": [
    ...existing,
    {
      "timestamp": "{RUN_TS}",
      "date": "{TODAY}",
      "mode": "first|update",
      "totalFound": N,
      "newFound": N,
      "uaCount": N,
      "globalCount": N,
      "topScore": X.XX,
      "reportPath": "{OUTPUT_EXCEL}/earn_{RUN_TS}.xlsx"
    }
  ],
  "lastRunDate": "{TODAY}",
  "knownIds": [ ...all current active listing IDs (union of previous + new) ]
}
```

Keep `runs` array max 50 entries. Keep `knownIds` up to 500 entries.

PRINT: `Стан збережено. Наступний запуск знайде тільки нові завдання.`

---

## Error Handling

| Problem | Action |
|---------|--------|
| API returns empty | PRINT warning, try with different skip |
| API 404/500 | PRINT error, suggest retry later |
| WebFetch detail page fails | Keep item with empty description |
| Judge returns invalid JSON | 2-tier parse fallback, default score 5 |
| ExcelJS missing | CSV fallback, do NOT install packages |
| State file corrupted | Delete, treat as first run |
| 0 listings after filter | PRINT "Немає завдань за заданими фільтрами" |
| 0 new listings (update) | PRINT info, update state, skip Excel |

---

## User Profile Context (for judges)

Pass this context to ALL judge agents:

```
Профіль користувача:
- Стек: JavaScript, TypeScript, Python, Solidity, Rust, Web3
- Інструмент: Claude Code (80-90% виконання коду)
- Час: ~5 годин/день
- Claude Code множник: 4-8x прискорення
- Локація: Україна
- Пріоритет: чіткі deliverables, development tasks, низька конкуренція
- Sweet spot нагороди: $200-$2,000
- Уникати: контент-only (відео, tweets), дизайн, фізична присутність
```
