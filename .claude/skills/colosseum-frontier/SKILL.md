---
name: colosseum-frontier
description: "Шукає та оцінює ідеї для Solana Frontier Hackathon (Colosseum). 1 пошуковець + 6 суддів, 10 ідей за запуск, результати в Excel. Triggers: '/colosseum-frontier', 'colosseum frontier', 'frontier hackathon', 'солана хакатон'."
user-invocable: true
argument-hint: "[--track defi|consumer|infrastructure|ai|gaming|depin|stablecoins|all]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(node *)
  - Bash(npm *)
  - Bash(mkdir *)
  - Bash(cp *)
  - Bash(mv *)
  - WebSearch
  - WebFetch
  - Agent
---

# Colosseum Frontier Hackathon — Idea Engine

**НІКОЛИ не вигадуй ідеї.** Кожна ідея базується на реальних WebSearch результатах.
**ВСІ дані в Excel та коментарі суддів — українською мовою.** Назви проєктів, технологій та специфічних термінів — оригінальною мовою.
**ФОКУС: Hidden gems та системно важливі проєкти для Solana.** Не шукай очевидні/банальні ідеї.
**VIBE-CODING: 90%+ розробки — Claude Code.** Стек, мова, технології не мають значення, головне — щоб Claude Code міг це побудувати.

## Hackathon Info

| Param | Value |
|---|---|
| Name | Solana Frontier Hackathon |
| Organizer | Colosseum |
| Dates | April 6 — May 11, 2026 (5 weeks) |
| Format | Online, global |
| Registration | https://arena.colosseum.org/hackathon/register |
| Tracks | Consumer, DeFi, Stablecoins, DePIN, Gaming, Infrastructure, AI |
| Grand Prize | $50,000 USDC |
| Track Prizes | $2,500 — $25,000 USDC per track |
| Public Goods | $10,000 USDC |
| Accelerator | Up to 15 winners get $250K pre-seed + mentorship + Demo Day |
| Judging Focus | Viable business model, founder-market fit, working demo, "aha moment", long-term vision |
| Demo | Working demo on devnet, video under 3 min |
| Timeline tip | 4 weeks engineering + 1 week polished submission |

## Developer Profile

| Param | Value |
|---|---|
| Dev style | Vibe-coding (90%+ Claude Code) |
| Skills | JS, Python, basic Web3/Solana — but stack doesn't matter since Claude Code writes the code |
| Team | Solo dev |
| Time | Full hackathon period (5 weeks) |
| Budget | Minimal (free tiers, devnet) |
| Main tool | Claude Code MAX (does 90%+ of implementation) |
| Focus | Hidden gems, underserved niches, system-critical infrastructure |

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **DATA_DIR**: `{WORKDIR}/data/colosseum-frontier`
- **EXCEL**: `{WORKDIR}/output/excel/colosseum-frontier/results.xlsx`
- **HISTORY**: `{DATA_DIR}/history.json`
- **EXCEL_SCRIPT**: `{WORKDIR}/scripts/generate-hackathon-excel.mjs`

## Parameters

Parse from `$ARGUMENTS`:

| Param | Default | Notes |
|-------|---------|-------|
| `--track` | `all` | `defi` `consumer` `infrastructure` `ai` `gaming` `depin` `stablecoins` `all` |

---

## Step 1: Init

1. Create directories:
```bash
mkdir -p {DATA_DIR} && mkdir -p {WORKDIR}/output/excel/colosseum-frontier && mkdir -p {WORKDIR}/output/pdf/colosseum-frontier && mkdir -p {WORKDIR}/output/md/colosseum-frontier
```

2. Read `{HISTORY}`. If missing, create:
```json
{"runs": []}
```

3. Set `RUN_ID` = `runs.length + 1`
4. Collect ALL previous idea names from all runs into `PREV_IDEAS` list (for dedup)
5. Parse `--track` argument if provided (default: "all")
6. Check ExcelJS: `node -e "require('exceljs')"`. If fails, run `npm install exceljs`.

PRINT:
```
COLOSSEUM FRONTIER — IDEA ENGINE
Run #: {RUN_ID} | Дата: {TODAY}
Трек: {TRACK}
Попередні ідеї: {PREV_IDEAS.length} (будуть виключені)
```

---

## Step 2: Searcher (1 Agent)

Launch **one** Agent (subagent_type: "general-purpose", model: "sonnet"). Pass it the full prompt below:

---BEGIN SEARCHER PROMPT---
You are a Solana hackathon idea researcher specializing in finding hidden gems and system-critical projects.

**HACKATHON:** Solana Frontier Hackathon (Colosseum), April 6 — May 11, 2026
**TRACKS:** Consumer, DeFi, Stablecoins, DePIN, Gaming, Infrastructure, AI
**TARGET TRACK:** {TRACK} (if "all" — pick from any track)

**WHAT JUDGES VALUE:**
- Viable business model (can become real startup)
- Working demo on devnet ("aha moment")
- Long-term vision beyond hackathon
- Founder-market fit
- Products that create new markets or significantly improve existing ones

**CRITICAL CONTEXT — VIBE-CODING:**
The project will be built with Claude Code doing 90%+ of the coding. This means:
- ANY technology stack is viable (Rust, TypeScript, Python, Anchor, etc.) — Claude Code handles it
- Complex on-chain programs (Solana programs in Rust/Anchor) ARE feasible
- Full-stack apps with frontend + backend + smart contracts ARE feasible
- The limiting factor is NOT technical skill but idea quality and market fit
- Focus on WHAT to build, not HOW — the how is solved by Claude Code

**YOUR MISSION — FIND HIDDEN GEMS:**
1. **Underserved infrastructure** — tools/protocols that Solana ecosystem NEEDS but nobody has built well yet. Search: "solana missing infrastructure 2026", "solana developer pain points", "solana ecosystem gaps".
2. **Emerging narratives** — trends that are gaining momentum but few projects address on Solana. Search: "solana emerging trends 2026", "crypto narrative shifts", "new solana use cases".
3. **Cross-pollination** — successful patterns from other chains (Ethereum, Cosmos, etc.) that don't exist on Solana yet. Search: "popular ethereum dapps not on solana", "missing solana defi protocols", "ethereum tools solana needs".
4. **Real-world demand** — projects where people are actively looking for solutions. Search Reddit, Twitter, Solana forums for complaints/requests.
5. **Public goods with business angle** — open-source tools that can win the $10K public goods prize AND become a business.

**DO NOT REPEAT THESE PREVIOUS IDEAS:**
{PREV_IDEAS}

**SEARCH INSTRUCTIONS:**
You MUST use WebSearch for each category. Make at least 12 different WebSearch calls.
Search for REAL demand signals, existing gaps, competitor analysis.
Also search: "colosseum hackathon winning projects" to understand what wins.

**Research areas to explore:**
1. Search "solana ecosystem gaps 2026" and "what solana needs but doesn't have"
2. Search "solana developer tools missing" and "solana devex pain points"
3. Search "defi primitives solana needs" and "solana defi innovation 2026"
4. Search "solana consumer apps opportunities" and "crypto consumer app trends"
5. Search "solana AI integration opportunities" and "AI x crypto projects 2026"
6. Search "colosseum hackathon winners" to learn from past winners
7. Search "solana stablecoin infrastructure needs"
8. Search "solana DePIN projects opportunities"
9. Search "solana gaming infrastructure needs"
10. Search for discussions on Twitter/Reddit: "solana wish there was", "solana needs", "missing on solana"
11. Search "hackathon winning strategies crypto 2026"
12. Search competitor ecosystems for ideas to port: "top ethereum dapps unique features"

**OUTPUT FORMAT — return EXACTLY this JSON array (no markdown wrapping):**
[
  {
    "id": 1,
    "name": "Short descriptive project name",
    "track": "one of: Consumer, DeFi, Stablecoins, DePIN, Gaming, Infrastructure, AI",
    "description": "3-4 sentences: what exactly is this, how does it work, what problem does it solve",
    "why_hidden_gem": "Why this is an underserved niche / hidden opportunity. What gap does it fill?",
    "demand_signals": "Real evidence of demand found via search (Reddit posts, Twitter complaints, ecosystem reports)",
    "existing_competitors": "Who already does something similar? Why is there room for improvement?",
    "business_model": "How this becomes a real business after the hackathon",
    "demo_wow_factor": "What makes the demo impressive for judges. The 'aha moment'",
    "tech_approach": "High-level architecture (Claude Code will handle implementation details)",
    "solana_specific": "Why this must be on Solana specifically (not just any chain)",
    "accelerator_pitch": "1-2 sentence pitch for $250K accelerator consideration",
    "estimated_complexity": "low | medium | high — relative to 5-week vibe-coding sprint"
  }
]

CRITICAL RULES:
- Every idea must be backed by WebSearch findings — NO hallucination
- Focus on HIDDEN GEMS, not obvious ideas (no generic DEX, no generic NFT marketplace, no basic wallet)
- Each idea must have a clear "why Solana" angle
- Each idea must be buildable in 5 weeks with Claude Code doing 90%+ of coding
- ALL text fields MUST be in Ukrainian. Project names, tech terms, protocol names — original language.
- At least 6 out of 10 ideas MUST be true hidden gems (few or no competitors on Solana)
- At least 3 ideas should target the Public Goods prize track as well
---END SEARCHER PROMPT---

Parse the searcher's response as JSON array of 10 ideas. If parse fails, ask the searcher to fix format.

---

## Step 3: Six Judges (6 Agents IN PARALLEL)

Launch **6 agents simultaneously** (all in a single message, model: "sonnet"). Each agent receives ALL 10 ideas and scores them on ONE criterion using a **1-100 scoring system**.

**IMPORTANT:** Pass the full 10-idea JSON to each judge. Each judge must return scores for ALL 10 ideas.

### Judge 1: Innovation & Uniqueness (weight: 0.20)

---BEGIN JUDGE 1 PROMPT---
You are a Solana ecosystem innovation expert. Score each of these 10 hackathon ideas on a scale of 1-100.

**Scoring criteria — INNOVATION & UNIQUENESS:**
- Is this something genuinely new in the Solana ecosystem? (USE WebSearch to verify no close competitors)
- Does it introduce a novel concept, mechanism, or approach?
- Is this a hidden gem — an underserved niche with real potential?
- Would this surprise judges in a positive way?
- Does it push boundaries of what's been done on Solana?

90-100 = truly novel, nothing like it exists on Solana, groundbreaking approach
70-89 = innovative twist on existing concept, clear differentiation
50-69 = somewhat novel, but similar projects exist with minor differences
30-49 = mostly derivative, incremental improvement over existing projects
1-29 = copycat, already well-served niche, nothing new

USE WebSearch to check for existing similar projects on Solana for at least the top 5 ideas.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 1 PROMPT---

### Judge 2: Vibe-Codability (weight: 0.20)

---BEGIN JUDGE 2 PROMPT---
You are a Claude Code capabilities expert and AI-assisted development specialist. Score each of these 10 hackathon ideas on a scale of 1-100.

**Scoring criteria — VIBE-CODABILITY:**
- Can Claude Code handle 90%+ of the implementation?
- Are there parts that require deep manual expertise Claude Code can't handle (novel cryptographic primitives, highly custom GPU code, etc.)?
- How well-documented are the required technologies? (Claude Code works better with well-documented APIs/SDKs)
- Can the MVP be realistically built in 5 weeks with vibe-coding?
- Are there good examples/templates/boilerplates Claude Code can reference?
- Does the project require extensive testing on real infrastructure (hardware, oracles, physical devices)?

90-100 = perfect for vibe-coding, well-documented stack, many examples, Claude Code can do 95%+
70-89 = very suitable, minor parts need manual work, mostly automatable
50-69 = doable but significant portions need manual guidance, some undocumented APIs
30-49 = challenging for vibe-coding, many custom/undocumented components
1-29 = not suitable for vibe-coding, requires deep specialized manual expertise

USE WebSearch to check documentation quality and available examples for the required tech stack.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 2 PROMPT---

### Judge 3: Prize Winning Potential (weight: 0.20)

---BEGIN JUDGE 3 PROMPT---
You are a hackathon judge and startup pitch expert. Score each of these 10 hackathon ideas on a scale of 1-100.

**CONTEXT:** Colosseum Frontier Hackathon (Solana). Judges value: viable business model, working demo ("aha moment"), founder-market fit, long-term vision. Grand Prize: $50K, Track Prizes: $2.5K-$25K, Public Goods: $10K. Top winners get $250K accelerator.

**Scoring criteria — PRIZE WINNING POTENTIAL:**
- Does this match what Colosseum judges historically reward? (USE WebSearch: "colosseum hackathon winners" to understand patterns)
- Is the demo visually impressive and easy to understand in 3 minutes?
- Does it have a clear business model judges would find viable?
- Does it tell a compelling story (problem → solution → market)?
- Would it stand out among 1000+ submissions?
- Does it fit well into one of the official tracks?

90-100 = extremely high chance of winning a prize, matches all judge criteria perfectly
70-89 = strong contender, likely to reach finals, clear strengths
50-69 = decent submission, could win with excellent execution
30-49 = average submission, unlikely to stand out
1-29 = weak fit for hackathon criteria, poor prize potential

USE WebSearch to research past Colosseum/Solana hackathon winners and what made them win.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 3 PROMPT---

### Judge 4: Market Demand & Timing (weight: 0.15)

---BEGIN JUDGE 4 PROMPT---
You are a crypto market analyst specializing in Solana ecosystem trends. Score each of these 10 hackathon ideas on a scale of 1-100.

**Scoring criteria — MARKET DEMAND & TIMING:**
- Is there proven demand for this type of product? (USE WebSearch to find demand signals)
- Are people actively asking for this on Twitter/Reddit/Discord?
- Is the timing right — is this trend growing or peaking?
- Does the current market cycle favor this type of project?
- Are there regulatory tailwinds or headwinds?
- Does this solve a problem that's getting worse (growing TAM)?

90-100 = massive demand, perfect timing, strong growth trend, people are begging for this
70-89 = clear demand signals, good timing, growing market
50-69 = moderate demand, timing is okay, market exists but not growing fast
30-49 = weak demand signals, might be too early or too late
1-29 = no evidence of demand, bad timing, shrinking market

USE WebSearch to verify demand signals for at least the top 5 ideas. Search Twitter, Reddit, Solana forums.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 4 PROMPT---

### Judge 5: Competition & Differentiation (weight: 0.15)

---BEGIN JUDGE 5 PROMPT---
You are a competitive analysis expert for the Solana ecosystem. Score each of these 10 hackathon ideas on a scale of 1-100.

**Scoring criteria — COMPETITION & DIFFERENTIATION:**
- How many direct competitors exist on Solana? (USE WebSearch to check)
- How many similar projects will likely be submitted to THIS hackathon?
- Is there a clear differentiation from existing solutions?
- Does the "hidden gem" angle hold up under scrutiny?
- Is the market winner-take-all or does it support multiple players?
- Can a solo vibe-coder compete with funded teams?

90-100 = no competitors on Solana, unique niche, unlikely to see duplicate submissions
70-89 = few weak competitors, clear differentiation, low submission overlap risk
50-69 = some competitors exist but room for improvement, moderate overlap risk
30-49 = crowded space, hard to differentiate, high chance of similar submissions
1-29 = dominated by established players, no clear advantage, many will submit similar ideas

USE WebSearch to check existing competitors on Solana for ALL 10 ideas.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 5 PROMPT---

### Judge 6: Post-Hackathon Potential (weight: 0.10)

---BEGIN JUDGE 6 PROMPT---
You are a crypto venture capitalist evaluating early-stage Solana projects. Score each of these 10 hackathon ideas on a scale of 1-100.

**CONTEXT:** Colosseum offers $250K pre-seed funding + accelerator to top winners. Judges want teams that will build full-time after the hackathon.

**Scoring criteria — POST-HACKATHON POTENTIAL:**
- Could this become a funded startup after the hackathon?
- Would VCs (especially Colosseum's fund) invest in this?
- Is there a path to revenue / token / sustainable business?
- Can a solo founder realistically grow this with $250K funding?
- Does the Solana ecosystem need this long-term?
- Is this building an asset (protocol, platform, user base) vs one-off tool?

90-100 = clear VC-fundable startup, strong path to revenue, ecosystem needs it long-term
70-89 = good startup potential, VCs would be interested, viable growth path
50-69 = could become a business but path is unclear, moderate VC interest
30-49 = mostly a hackathon project, limited business potential
1-29 = no business viability, one-off tool, no VC interest

USE WebSearch to check similar projects that received funding in crypto/Solana space.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 75, "justification": "2-3 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 6 PROMPT---

---

## Step 4: Aggregate & Rank

Parse all 6 judge responses. For each idea compute:

```
total = (innovation * 0.20) + (vibe_codability * 0.20) + (prize_potential * 0.20) + (market_demand * 0.15) + (competition * 0.15) + (post_hackathon * 0.10)
```

Sort ideas by `total` descending. Assign `rank` 1-10.

Build the final results object:
```json
{
  "run_id": RUN_ID,
  "date": "TODAY",
  "track_filter": "TRACK",
  "hackathon": "Colosseum Frontier",
  "ideas": [
    {
      "rank": 1,
      "name": "...",
      "track": "...",
      "description": "...",
      "why_hidden_gem": "...",
      "demand_signals": "...",
      "existing_competitors": "...",
      "business_model": "...",
      "demo_wow_factor": "...",
      "tech_approach": "...",
      "solana_specific": "...",
      "accelerator_pitch": "...",
      "estimated_complexity": "...",
      "scores": {
        "innovation": {"score": 85, "justification": "..."},
        "vibe_codability": {"score": 90, "justification": "..."},
        "prize_potential": {"score": 78, "justification": "..."},
        "market_demand": {"score": 72, "justification": "..."},
        "competition": {"score": 88, "justification": "..."},
        "post_hackathon": {"score": 65, "justification": "..."}
      },
      "total_score": 81.30
    }
  ]
}
```

## Step 5: Save to Excel

1. Write the results JSON to `{DATA_DIR}/run_{RUN_ID}.json`
2. Run:
```bash
node {EXCEL_SCRIPT} {DATA_DIR}/run_{RUN_ID}.json {EXCEL} {RUN_ID}
```

The script adds a NEW sheet named `Run_{RUN_ID}_{DATE}` to the existing Excel file (if it exists), preserving previous runs as separate sheets. The first sheet is always an updated "Leaderboard" with ALL ideas across ALL runs.

## Step 6: Update History

Read `{HISTORY}`, append new run:
```json
{
  "runs": [
    ...existing,
    {
      "run_id": RUN_ID,
      "date": "TODAY",
      "track_filter": "TRACK",
      "ideas": ["idea name 1", "idea name 2", ...]
    }
  ]
}
```
Write back to `{HISTORY}`.

## Step 7: Display Results

Show TOP-5 ideas as a table:

| # | Idea | Track | Score | Complexity | Hidden Gem? |
|---|------|-------|-------|------------|-------------|
| 1 | ...  | DeFi  | 81.30 | medium     | ...         |

For each TOP-5 idea, show:
- **What:** 2-3 sentences about the idea
- **Why hidden gem:** Why this is underserved
- **Demo wow:** What makes the demo impressive
- **Accelerator pitch:** 1-2 sentence pitch
- **Top scores:** Which criteria scored highest

Then say: `Full results saved to: {EXCEL}`

---

## Error Handling

- If searcher returns <10 ideas: accept what you got, note gap
- If a judge fails to return valid JSON: parse what you can, score missing items as 50
- If Excel script fails: save raw JSON as fallback, report error
- If WebSearch fails in an agent: agent should try alternative search queries
- If ExcelJS is not installed: run `npm install exceljs` and retry
