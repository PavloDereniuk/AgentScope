---
name: bounty-hunt
description: "Find and evaluate earning opportunities: bounties, hackathons, audit contests, grants. Use /bounty-track for watchlist, /bounty-log for outcomes. Triggers: 'bounty hunt', 'find bounties', 'earning opportunities', 'знайди баунті', 'пошук заробітку'."
user-invocable: true
argument-hint: "[quick|deep] [--type audit|bounty|hackathon|grant|all] [--focus web3|ai] [--min-reward N] [--deadline-within Nd] [--exclude-platform id1,id2] [--platforms id1,id2] [--auto-track N] [--new-only] [--refresh] [--budget N] [--quiet] [--verbose] [--setup] [--force-agents]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Bash(node *)
  - Bash(gh *)
  - Bash(npm *)
  - Bash(mkdir *)
  - Bash(mv *)
  - Bash(rm data/bounty-hunt/*)
  - WebSearch
  - WebFetch
  - Agent
---

# Bounty Hunter — Earning Opportunity Finder

**NEVER fabricate opportunities.** Every item must come from real search results with a real URL.

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **YEAR**: !`node -e "console.log(new Date().getFullYear())"`
- **RUN_TS**: !`node -e "const d=new Date();console.log(d.toISOString().slice(0,10)+'_'+d.toTimeString().slice(0,5).replace(':','-'))"`
- **BOUNTY_DIR**: `WORKDIR/data/bounty-hunt`
- **SCRIPTS**: `WORKDIR/scripts`
- **OUTPUT_EXCEL**: `WORKDIR/output/excel/bounty-hunt`
- **OUTPUT_MD**: `WORKDIR/output/md/bounty-hunt`
- **SKILL_DIR**: `WORKDIR/.claude/skills/bounty-hunt`

## Parameters

Parse from `$ARGUMENTS`:

| Param | Default | Notes |
|-------|---------|-------|
| mode (positional) | `default` | `quick` / `default` / `deep` |
| `--type` | `all` | `bounty` `audit` `hackathon` `grant` `quest` `bug-bounty` `all` |
| `--focus` | `web3` | `web3` `ai` `general` |
| `--min-reward` | `0` | USD threshold |
| `--max-reward` | off | USD ceiling — filter out items above this |
| `--reward-sweet-spot` | `200-2000` | Reward range that gets scoring boost |
| `--deadline-within` | off | days, e.g. `7d` |
| `--max-hours` | `40` | Max estimated hours to complete (filters complex tasks) |
| `--new-only` | off | exclude items from previous runs |
| `--refresh` | off | ignore cache |
| `--exclude-platform` | none | comma-separated ids to skip |
| `--exclude-type` | `bug-bounty` | comma-separated types to exclude by default |
| `--platforms` | none | comma-separated ids to search ONLY these |
| `--auto-track` | off | auto-add top-N to watchlist |
| `--budget` | quick=15, default=40, deep=70 | max WebSearch+WebFetch calls |
| `--quiet` | off | minimal output |
| `--verbose` | off | debug output |
| `--setup` | off | first-run wizard: profile + API test |
| `--force-agents` | off | launch agents even if underperforming |
| `--include-bug-bounty` | off | override default bug-bounty exclusion |

### Mode capabilities

| Mode | Agents | Platforms | Export | Action Plans | Budget |
|------|--------|-----------|--------|-------------|--------|
| quick | 0 | API-capable + Tier 1 | Markdown | No | 15 |
| default | 1 | Tier 1-2 | MD+Excel | Top 3 | 40 |
| deep | 2 | All tiers | MD+Excel | Top 5 | 70 |

**Quick mode** targets 1-2 minutes: only platforms with working APIs or Tier 1, skip verification of non-API items, basic scoring.

---

## Task Philosophy — What We're Looking For

**PRIORITY: Small, achievable tasks with clear deliverables.**

The user works with Claude Code (handles 80-90% of execution). Ideal tasks:
- **Reward sweet spot:** $200-$2,000 (up to $5K for hackathons)
- **Time to complete:** 1 day to 1 week
- **Clear deliverable:** code, PR, prototype, tool, integration
- **Low/medium competition:** fewer than 50 submissions

**DEPRIORITIZE or EXCLUDE by default:**
- `bug-bounty` type — ongoing programs running 1+ years are picked over by thousands of researchers. Finding new bugs is effectively a lottery. **Excluded by default** unless `--include-bug-bounty` flag is set.
- Tasks with reward $50K+ and no deadline (usually means "ongoing program, good luck finding something")
- Content-only tasks (video, tweets, threads) — poor Claude Code fit
- Tasks requiring physical presence or KYC-gated access

**BOOST in scoring:**
- Tasks with clear scope and defined deliverables
- Bounties posted within last 30 days (fresh)
- Low submission count (from API data where available)
- Development tasks: smart contracts, APIs, SDKs, tools, integrations, dashboards
- Tasks where Claude Code provides decisive advantage (code generation, auditing, analysis)

### Type exclusion logic
1. Parse `--exclude-type` (default: `bug-bounty`)
2. If `--include-bug-bounty` → remove `bug-bounty` from exclude list
3. If `--type` is explicitly set → override `--exclude-type` for that type
4. Apply exclusion in Step 2 (dedup/filter), not Step 1 (search), so bug-bounty items are still collected but filtered before scoring

---

## --setup Mode

If `--setup` flag OR no `.bounty/profile.json` AND no `.bounty/platform-health.json`:

### 1. Create profile
Ask user (or use defaults if `--quiet`):
```
Profile setup:
  Tech stack? [JS, Python, Solidity, Web3]
  Anti-stack (deprioritize)? [Rust, ML, Figma]
  Hours/day for bounties? [5]
  Claude Code speed multiplier? [4]
  Focus: web3/ai/general? [web3]
```
Save to `BOUNTY_DIR/profile.json`.

### 2. Test APIs
```bash
node SCRIPTS/platform-test.mjs --output BOUNTY_DIR/platform-health.json
```
Print results. This tells which APIs work and which need WebSearch fallback.

PRINT: `Setup complete. Run /bounty-hunt to start searching.` → **EXIT**.

---

## Step 0: Pre-flight

### Init & checks
```bash
node -e "const fs=require('fs');['data/bounty-hunt/reports','data/bounty-hunt/learned','output/excel/bounty-hunt','output/md/bounty-hunt'].forEach(d=>fs.mkdirSync(d,{recursive:true}))"
```

1. **Lockfile**: if `.bounty/hunt.lock` exists AND < 15 min old → PRINT warning → **EXIT**. If stale → delete. Create lock.
2. **Budget**: `node SCRIPTS/budget-tracker.mjs init BUDGET_LIMIT`
3. **Profile**: read `.bounty/profile.json` (defaults if missing).
4. **Tools**: check `gh auth status` → set HAS_GH. Check `node -e "require('exceljs')"` → set HAS_EXCEL (skip in quick).
5. **History**: read `BOUNTY_DIR/history.json` (create `{"found":[],"outcomes":[]}` if missing).
6. **Learned data**: read `BOUNTY_DIR/learned/learned.json` if exists (see `learning.md`).
7. **Platform health**: read `BOUNTY_DIR/platform-health.json` if exists.

### Cache check
Read `BOUNTY_DIR/cache.json`. For each platform: if cached < `cacheTTL` seconds AND matching focus AND NOT `--refresh` → load cached results, mark `skipSearch: true`.

PRINT (unless `--quiet`):
```
BOUNTY HUNT — MODE mode | TODAY
Focus: FOCUS | Type: TYPE | Budget: LIMIT
Tools: gh=Y/N | Excel=Y/N | Cached: N platforms
```

### Platform selection
Read `SKILL_DIR/platforms.json`:
1. Filter out `status: "deprecated"` and `--exclude-platform`.
2. If `--platforms` set → keep ONLY those platforms.
3. Else filter by tier: quick → tier 1 + API-capable, default → tier ≤ 2, deep → all.
4. Filter by `--type` if set.
5. Skip `skipSearch: true` (cached).
6. Sort by `priority`. Separate into `MAIN_PLATFORMS` (owner=main) and `AGENT_PLATFORMS`.
7. Platforms with `platform-health.json` showing `api.status: "ok"` → mark `useApi: true`.

PRINT: `Searching N platforms (M main + K via agents)...`

---

## Step 1: Search

### Rules
- **NEVER fabricate.** Every item from real search/fetch.
- Only **active & open** opportunities.
- Max **12 items per source**.
- **Before each WebSearch/WebFetch**: run `node SCRIPTS/budget-tracker.mjs use` — if exit code 2 → stop searching.
- Checkpoint: after each source, append items to `BOUNTY_DIR/wip.jsonl`.

### 1a. API-first platforms

For each platform with `useApi: true` (budget: 1 call each):
1. WebFetch the `apiUrl`. Parse with `apiSchema` field mappings.
2. If valid JSON with items → extract, mark `source: "api"`.
3. If fails → fallback to WebSearch in 1b.

PRINT after each: `[M/N] Platform: found X items (API)`

### 1b. WebSearch platforms

For each remaining MAIN_PLATFORM (not covered by 1a or aggregator):
1. **Aggregator logic**: ONLY skip `aggregates[]` platforms if aggregator actually yielded ≥3 results. If solodit API failed AND WebSearch gave 0 → DO NOT skip code4rena, sherlock, cantina, codehawks.
2. Run best query (from learned data, or default `searchQueries[0]`). Budget: 1 call.
3. If < 2 results AND budget allows → try `searchQueries[1]`. Budget: 1 call.
4. For non-SPA platforms (`isSPA: false`): WebFetch top 2-3 URLs. Budget: 2-3 calls.
5. **For SPA platforms**: use search snippet text. Additionally, if search returns **individual item URLs** (not listing pages), WebFetch up to 2 of those. Individual item URLs contain specific paths like `/competitions/UUID`, `/bug-bounty/NAME/`, `/contests/NAME`. Budget: 1-2 calls.
6. Extract per item: `name, url, reward, deadline, platform, type, description`.

PRINT after each: `[M/N] Platform: found X items`

### 1c. GitHub

**If HAS_GH** (0 budget):
```bash
gh search issues --label=bounty --sort=created --order=desc --limit=15 -- "bounty"
gh search issues --label="help wanted" --sort=created --order=desc --limit=10 -- "reward OR bounty OR prize"
```
**Else** (1 budget): WebSearch `site:github.com label:bounty "reward" YEAR`.

### 1d. Cross-platform discovery (default/deep only)

**Purpose:** Find opportunities from platforms NOT in platforms.json, or from aggregator articles listing multiple opportunities. This runs in MAIN search, not via agent. Budget: 2-4 calls.

Run 2 broad discovery WebSearches in **parallel**:
1. `"web3 developer bounty task reward YEAR active open -immunefi -hackerone"` (1 budget)
2. `"blockchain hackathon prize YEAR online open submission"` (1 budget)

For each search, extract items with real URLs. WebFetch the top 1-2 promising URLs that are NOT SPA listing pages (blog posts, announcement pages, individual hackathon pages are OK). Budget: 1-2 calls.

Mark items with `source: "discovery"`. This catches opportunities from HackenProof, Devfolio, ETHGlobal, Dework, and other platforms not in platforms.json.

PRINT: `Discovery: found X items from Y sources`

### 1e. Agent subagents (default/deep only)

Read `SKILL_DIR/agents.md` for prompts and config.
1. Determine agents by mode (default=1, deep=2).
2. Check learned data — skip agents with `consecutiveZero >= 3` AND `qualityRate < 0.1` (unless `--force-agents`).
3. Launch ALL agents in **single message** for parallel execution.
4. Parse agent output per `agents.md` 2-tier fallback.
5. **If agent is rejected/fails**: DO NOT lose coverage. Fall back to 1-2 additional WebSearches covering the agent's top-priority platforms (sorted by platform priority). Budget: 2 calls max. This ensures tier-2 platforms still get searched even without agents.

PRINT: `Agents returned: X + Y items` (or `Agent failed — fallback search: X items`)

---

## Step 2: Process

### 2a. Merge
Collect all results: cached + API + search + GitHub + agents.

### 2b. Dedup & Filter (script)
Write collected items to `BOUNTY_DIR/raw-items.json`, then:
```bash
node SCRIPTS/dedup.mjs BOUNTY_DIR/raw-items.json --history BOUNTY_DIR/history.json [--new-only] [--min-reward N] [--max-reward N] [--deadline-within Nd] [--type TYPE] [--exclude-type bug-bounty]
```
**Default:** Pass `--exclude-type bug-bounty` unless `--include-bug-bounty` was set by user. This filters out ongoing bug bounty programs that are effectively lotteries.
Parse stdout JSON → `{items, stats}`.

PRINT: `Processed: INPUT raw → VALID valid (DROPPED_SCHEMA schema, DROPPED_DEDUP dedup, DROPPED_FILTER filter, SEEN seen)`

### 2c. Verification (budget-aware)

**For top 10 items** (sorted by reward descending):
1. Check budget: `node SCRIPTS/budget-tracker.mjs check` — if `warning: true`, verify only top 5.
2. Pre-check: if URL matches pattern in learned `drops.urlPatterns[]` with `dropCount >= 5` → `verified: "suspect"`, skip fetch.
3. WebFetch the URL (1 budget each).
4. Evaluate: 404/redirect→DROP. Page confirms→`verified: true`. Closed→DROP. SPA/empty→`verified: "partial"`.

**Quick mode**: skip verification for non-API items. API items get `verified: true` automatically.

**Remaining items**: API source → `verified: true`. Known SPA → `verified: "partial"`. Others → `verified: "partial"`.

PRINT: `Verified: V | Partial: P | Dropped: D`
Delete `BOUNTY_DIR/raw-items.json`.

---

## Step 3: Score

### 3a. Deterministic scores (script)
Write items to `BOUNTY_DIR/score-input.json`, then:
```bash
node SCRIPTS/score-calc.mjs BOUNTY_DIR/score-input.json --profile BOUNTY_DIR/profile.json --history BOUNTY_DIR/history.json
```
Parse stdout → items with `_det` field containing: `deadlineScore, payoutBase, competition, techStackAdj, calibrationAdj, confidenceWeight`.

### 3b. LLM-assessed scores

Read `SKILL_DIR/scoring.md` for criteria details.

For each item, assess (using `_det` as base):
1. **Payout** (25%): start from `_det.payoutBase`, apply red/green flags from page content. Clamp 5-100.
2. **ROI** (25%): assess complexity, hours, hidden costs. Apply `_det.competition.adj` + `_det.calibrationAdj`. Clamp 0-100.
3. **Claude Code Fit** (20%): assess task match. Apply `_det.techStackAdj`. Clamp 0-100.
4. **Strategic Value** (15%): assess long-term benefits. Apply user signal adjustment from learned data. Clamp 0-100.
5. **Deadline** (15%): use `_det.deadlineScore` directly (no LLM needed).

**Total**: `roi*0.25 + payout*0.25 + claude*0.20 + deadline*0.15 + strategic*0.15`

### 3c. Ranking (confidence-weighted)

**rankScore = totalScore * confidenceWeight**

Sort by `rankScore` descending. This prevents unverified high-score items from dominating.

PRINT per item (unless `--quiet`):
```
[1] LayerZero Bug Bounty — $5K-$200K | immunefi.com
    ROI:85 Pay:90 CC:80 DL:95 Str:70 -> TOTAL: 85 | rank: 72 | Comp: Medium | conf:85% | verified
```

Delete `BOUNTY_DIR/score-input.json`.

---

## Step 4: Report

### Action Plans (skip in quick)
For top 3 (top 5 in deep) with score >= 50:
```
ACTION PLAN — #1: [Name] (Score: XX, Confidence: YY%)
|-- Час: ~Xh з Claude Code
|-- Крок 1: [конкретна перша дія]
|-- Крок 2: [аналіз/робота]
|-- Крок 3: [deliverable]
|-- Подати: [як, куди, дедлайн]
|-- Старт: [команда або URL]
```

### Terminal output
```
===================================================
  BOUNTY HUNT — MODE | TODAY
  Знайдено: N | Верифіковано: V | Бюджет: USED/LIMIT
===================================================

ТОП РЕЗУЛЬТАТИ:

1. [Name] [NEW] conf:XX%
   $XXX | дедлайн YYYY-MM-DD | type | platform
   ROI:XX Pay:XX CC:XX DL:XX Str:XX -> TOTAL: XX | rank: XX
   https://...
   Чому: [1 речення]

===================================================
```

### Delta report (if previous run exists in learned data)
Compare with last run: `+N нових | ~M ще активні | -K зникли | !J deadline<3d`

### Auto-track
If `--auto-track N`: add top-N (score >= 50) to watchlist. Else if any >= 65 → suggest `/bounty-track` commands.

### Save files

**Reports are archived in timestamped folders to preserve history:**

```bash
mkdir -p BOUNTY_DIR/reports/RUN_TS
```

1. **Markdown report**: write `OUTPUT_MD/hunt_RUN_TS.md`.
2. **Excel** (default/deep, if HAS_EXCEL):
   ```bash
   node SCRIPTS/generate-bounty-excel.mjs BOUNTY_DIR/data-tmp.json "OUTPUT_EXCEL/hunt_RUN_TS.xlsx"
   ```
   If no Excel → CSV fallback to `OUTPUT_EXCEL/hunt_RUN_TS.csv`.
4. **Cache**: write `BOUNTY_DIR/cache.json` with per-platform results and timestamps.
5. **Platform health**: update `BOUNTY_DIR/platform-health.json` with search results per platform.
6. **History**: append verified/partial results to `history.json` `found[]` (keep last 500).
7. **Budget**: `node SCRIPTS/budget-tracker.mjs reset`

### Cleanup
Delete `BOUNTY_DIR/wip.jsonl`, `BOUNTY_DIR/hunt.lock`, temp JSON files.

PRINT: `Reports: output/excel/bounty-hunt/ + output/md/bounty-hunt/`

---

## Step 5: Learn

Read `SKILL_DIR/learning.md` for the combined `learned.json` spec. Update `BOUNTY_DIR/learned/learned.json`:

1. **Queries**: record results per platform query, update avgResults, dropRate.
2. **Agents**: record items, parse tier, update qualityRate, consecutiveZero.
3. **Drops**: record dropped URL patterns, add new falsePositiveSignals.
4. **Runs**: append run summary (keep last 50).
5. **UserSignals**: items in 3+ runs but never tracked → increment ignored.

### Self-Review (unless `--quiet`)
```
SELF-REVIEW:
  Data quality: X% survived verification
  Best source: Platform (Y verified)
  Budget: USED/LIMIT
  Suggestion: [one actionable improvement or "none"]
```

PRINT: `Done. Знайдено N можливостей.`

---

## Error Handling

| Problem | Action |
|---------|--------|
| Platform returns 0 | Log in health, continue |
| WebFetch empty (SPA) | Use snippet data, `verified: "partial"` |
| WebFetch 404/redirect | Drop item |
| Rate limited | Stop external calls, process what we have |
| Budget exhausted (exit code 2) | Stop searching, process collected results |
| API non-JSON/error | Log `apiSuccess: false`, fallback to WebSearch |
| Agent invalid output | 2-tier parse fallback (see agents.md) |
| Agent returns 0 | Increment consecutiveZero |
| Missing name/url/platform | dedup.mjs drops automatically |
| `gh` unavailable | WebSearch fallback |
| ExcelJS missing | CSV fallback, do NOT install packages |
| Profile missing | Use defaults, suggest `--setup` |
| Cache/health corrupted | Delete, start fresh |
| Lock stale (>=15min) | Delete, proceed |
| 0 results total | Report 0 found, cleanup normally |
| Fewer than expected | **NEVER pad with fabricated items** |
