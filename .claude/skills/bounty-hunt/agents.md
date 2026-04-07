# Agent Configuration

## Platform Ownership

**Main search owns:** `solodit` (+aggregated: code4rena, sherlock, codehawks, cantina), `immunefi`, `hackerone`, `superteam`, `bugcrowd`, `spearbit`, `ethereum-foundation`, `devpost`, `GitHub`, + cross-platform discovery searches

Agents own remaining platforms + platform-specific discovery.

**IMPORTANT — Agent fallback:** If agent is rejected or fails, main search MUST run 1-2 additional WebSearches to cover the agent's top-priority platforms. This prevents losing coverage of 11+ platforms when agent is unavailable.

## Allocation by Mode

| Mode | Agents |
|------|--------|
| quick | none |
| default | discovery-bounties |
| deep | discovery-bounties, discovery-hackathons |

---

## Agent: discovery-bounties

**Runs in:** default, deep
**Platforms:** Bountycaster, OnlyDust, Hats Finance, Gitcoin, Intigriti, YesWeHack, Secure3, Optimism Grants, Solana Grants, Chainlink, Trust Security

### Prompt

```
You are a Web3 bounty researcher. Find ACTIVE, ACHIEVABLE earning opportunities in {YEAR}.

TASK:
1. Search ASSIGNED platforms for active opportunities.
2. Run 1 discovery query for NEW sources.
3. Return JSON between markers.

PRIORITY: Focus on tasks with CLEAR DELIVERABLES that a skilled developer with AI tools can complete in 1-7 days. Ideal reward range: $200-$2,000. SKIP ongoing bug bounty programs (running 1+ years) — they are picked over by thousands of researchers.

PLATFORMS:
{PLATFORM_QUERIES}

DISCOVERY: "web3 bounty program active {YEAR} -immunefi -hackerone developer task reward"

FOCUS: {FOCUS}
SKIP URLS: {DEDUP_URLS_FIRST_30}
{QUALITY_WARNING}

RULES:
- NEVER fabricate. Real search results only.
- Only ACTIVE/OPEN items. Max 12 total.
- PREFER bounties with specific deliverables over open-ended bug hunting.
- Do NOT WebFetch SPA listing pages. Only individual item pages.
- Max 3 WebFetch per platform.

OUTPUT — exactly this format, nothing outside markers:
---BOUNTY-JSON-START---
[{"name":"...","url":"https://...","platform":"...","type":"bounty|grant|audit-contest|open-source","reward":"$X or TBD","deadline":"YYYY-MM-DD or null","description":"max 80 chars","source":"agent-bounties","dateSpotted":"{TODAY}"}]
---BOUNTY-JSON-END---
```

---

## Agent: discovery-hackathons

**Runs in:** deep only
**Platforms:** DoraHacks, Questbook, Layer3, Zealy, Galxe, Kaggle (Devpost moved to main — has working API)

### Prompt

```
You are a hackathon researcher. Find ACTIVE competitions with prizes in {YEAR}.

TASK:
1. Search ASSIGNED platforms for active opportunities.
2. Run 1 discovery query for NEW sources.
3. Return JSON between markers.

PLATFORMS:
{PLATFORM_QUERIES}

DISCOVERY: "online hackathon prize money {YEAR} blockchain OR web3 OR AI"

FOCUS: {FOCUS}
SKIP URLS: {DEDUP_URLS_FIRST_30}
{QUALITY_WARNING}

RULES:
- NEVER fabricate. Real search results only.
- Only ACTIVE/OPEN items. Max 12 total.
- Do NOT WebFetch SPA listing pages. Only individual item pages.
- Max 3 WebFetch per platform.

OUTPUT — exactly this format, nothing outside markers:
---BOUNTY-JSON-START---
[{"name":"...","url":"https://...","platform":"...","type":"hackathon|competition|quest|grant","reward":"$X or TBD","deadline":"YYYY-MM-DD or null","description":"max 80 chars","source":"agent-hackathons","dateSpotted":"{TODAY}"}]
---BOUNTY-JSON-END---
```

---

## Constructing Prompts (Step 1d)

1. **Platform queries**: for each assigned platform, take `searchQueries[]` from platforms.json. Replace `{YEAR}`. If learned data has better-performing query → use it.
2. **DEDUP_URLS**: first 30 from history + current run.
3. **QUALITY_WARNING** (if learned data shows `qualityRate < 0.3` over 5+ runs):
   ```
   WARNING: Your previous results had high drop rate. Only include items with REAL, WORKING URLs from search results.
   ```
4. **FOCUS and TODAY** from context.

---

## Parsing Agent Output — 2-tier fallback

### Tier 1: Marker extraction
Extract between `---BOUNTY-JSON-START---` and `---BOUNTY-JSON-END---` → `JSON.parse()`.

### Tier 2: Bracket extraction
Find first `[` and last `]` → `JSON.parse()`. Then validate each object has `name`, `url`, `platform`.

If both fail → log warning, 0 items from this agent.

### Schema validation (after parsing)
- **REQUIRED**: `name` (non-empty), `url` (starts with `http`), `platform` (non-empty) → DROP if missing.
- **DEFAULTS**: `type`→"unknown", `reward`→"TBD", `deadline`→null, `description`→"", `source`→"agent".

PRINT: `Agent [NAME]: X items parsed (tier N), Y valid after schema check`

---

## Skipping Underperforming Agents

From learned data: `consecutiveZero >= 3` AND `qualityRate < 0.1` → skip with warning (override: `--force-agents`).
