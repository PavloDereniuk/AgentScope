---
name: income-find
description: "Шукає та оцінює ідеї заробітку для досягнення $100K/рік. 1 пошуковець + 5 суддів, 10 ідей за запуск, результати в Excel. Triggers: '/income-find', 'income find', 'знайди дохід', 'пошук заробітку 100к'."
user-invocable: true
argument-hint: "[--category saas|freelance|bots|plugins|api|automation|all]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(python *)
  - Bash(pip *)
  - Bash(mkdir *)
  - Bash(node *)
  - Bash(cat *)
  - WebSearch
  - WebFetch
  - Agent
---

# Income Finder — $100K/Year Opportunity Engine

**НІКОЛИ не вигадуй ідеї.** Кожна ідея базується на реальних WebSearch результатах.
**НЕ має жодного відношення до bounty-hunt скіла.** Повністю незалежна система.
**ВСІ дані в Excel ПОВИННІ бути українською мовою.** Описи ідей, коментарі суддів (justification), категорії — все українською. Назви продуктів, технологій та специфічні терміни залишати оригінальною мовою. Агенти-судді повинні повертати justification українською.

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **DATA_DIR**: `{WORKDIR}/data/income-finder`
- **EXCEL**: `{WORKDIR}/output/excel/income-finder/results.xlsx`
- **HISTORY**: `{DATA_DIR}/history.json`
- **EXCEL_SCRIPT**: `{WORKDIR}/scripts/generate_excel.py`

## User Profile (FIXED)

| Param | Value |
|---|---|
| Goal | $100,000 / 12 months = ~$8,333/mo |
| Time | 20 hours/week |
| Budget | $100 + Claude Code MAX |
| Skills | JavaScript, Node.js, Python, basic Web3/Solana |
| Main tool | Claude Code (does 80-90% of work) |
| Portfolio | None |
| Audience | None |
| Creativity | NO (no content, design, copywriting) |
| English | Technical docs only (NO client communication) |
| Location | Ukraine |

## Step 1: Init

1. `mkdir -p {DATA_DIR}` and `mkdir -p {WORKDIR}/output/excel/income-finder`
2. Read `{HISTORY}`. If missing, create:
```json
{"runs": []}
```
3. Set `RUN_ID` = `runs.length + 1`
4. Collect ALL previous idea names into `PREV_IDEAS` list (for dedup)
5. Parse `--category` argument if provided (default: "all")

## Step 2: Searcher (1 Agent)

Launch **one** Agent (subagent_type: "general-purpose", model: "sonnet"). Pass it the full prompt below, substituting `{PREV_IDEAS}` and `{TODAY}`:

---BEGIN SEARCHER PROMPT---
You are an income opportunity researcher. Find 10 NEW, SPECIFIC, REALISTIC income ideas.

**PRIORITY FOCUS — "HIDDEN GEMS" & EMERGING TRENDS:**
Your PRIMARY goal is to find ideas that are NOT yet mainstream or heavily competed. Prioritize:
1. **Hidden gems** — niches with real demand but very few competitors. Look for problems people complain about on Reddit/HN/Twitter but nobody has built a good solution for yet. Search: "underserved niche saas {YEAR}", "no good solution for reddit", "I wish there was a tool for".
2. **Emerging trends** — ideas that aren't popular NOW but show strong growth signals. Technologies, regulations, or market shifts that will create demand in 6-12 months. Search: "emerging tech trends {YEAR}", "new regulation creating business opportunities", "growing developer needs {YEAR}".
3. **Blue ocean niches** — micro-niches inside larger markets where big players don't bother competing. A specific vertical (e.g., "invoice tool for freelance translators" vs generic "invoice tool"). Search: "niche saas success stories", "vertical saas small market".
- AVOID ideas in saturated markets (uptime monitoring, generic SEO tools, generic chatbots, etc.)
- For EACH idea, explain WHY competition is low and what growth signals you found

**USER PROFILE:**
- Skills: JS, Node.js, Python, basic Web3/Solana
- Time: 20 hrs/week
- Budget: $100 startup
- Tool: Claude Code (does 80-90% of coding work)
- NOT suitable: creativity, design, copywriting, English-language client calls
- No portfolio, audience, or clients
- Location: Ukraine
- Goal: $100K in 12 months (~$8,333/mo)

**DO NOT REPEAT THESE PREVIOUS IDEAS:**
{PREV_IDEAS}

**SEARCH INSTRUCTIONS:**
You MUST use WebSearch for EACH category below. Make at least 10 different WebSearch calls.
Look for REAL revenue data, success stories, market demand, and pricing.

Categories to research (pick ideas from at least 5 different categories):
1. **Micro-SaaS** — search: "micro saas revenue examples {YEAR}", "indie hacker profitable saas"
2. **AI-powered tools** — search: "ai tool business revenue {YEAR}", "selling ai api services"
3. **Telegram/Discord bots** — search: "telegram bot monetization {YEAR}", "paid telegram bot examples"
4. **Browser extensions** — search: "chrome extension revenue model", "profitable browser extensions {YEAR}"
5. **WordPress/Shopify plugins** — search: "wordpress plugin sales revenue", "shopify app developer income"
6. **Paid APIs** — search: "rapidapi developer earnings", "api monetization business"
7. **Automation services** — search: "selling automation services", "n8n make.com business"
8. **Web scraping / data services** — search: "web scraping as a service business", "data service revenue"
9. **Developer tools** — search: "developer tool monetization", "paid dev tools revenue"
10. **Digital products / templates** — search: "selling code templates revenue", "boilerplate business"
11. **Freelance (async, no calls)** — search: "async remote developer work no meetings", "freelance platforms no interviews {YEAR}"
12. **White-label / resell** — search: "white label saas reseller", "reselling software business"

**OUTPUT FORMAT — return EXACTLY this JSON array (no markdown wrapping):**
[
  {
    "id": 1,
    "name": "Short descriptive name",
    "category": "one of the categories above",
    "description": "2-3 sentences: what exactly is this, how does it work",
    "monetization": "Specific pricing model (e.g. $29/mo subscription, $5/API call, etc.)",
    "monthly_potential": "$X-$Y range based on research",
    "time_to_first_revenue": "X weeks/months realistically",
    "real_examples": "Names and revenue figures of real similar products found via search",
    "why_realistic": "Why this works for a solo dev with Claude Code and 20hrs/week",
    "tech_stack": "Specific technologies needed",
    "claude_code_role": "What exactly Claude Code does (e.g. writes backend, generates tests, etc.)",
    "competition_level": "low | medium | high — based on actual search for competitors",
    "competition_details": "Who are the competitors? Why is there room for a new player?",
    "growth_signal": "For future bets: what trend or shift will drive demand? (empty string if not a future bet)"
  }
]

CRITICAL RULES:
- Every idea must be backed by WebSearch findings — no hallucination
- Do NOT suggest bug bounties, security audits, or hackathons
- Do NOT suggest anything requiring design skills, video creation, or copywriting
- Do NOT suggest anything requiring live English calls with clients
- Be SPECIFIC: "SaaS for X that does Y" not "build some SaaS"
- Include REAL revenue examples from your search results
- ALL text fields (description, monetization, why_realistic, claude_code_role) MUST be in Ukrainian. Product names, tech terms, and proper nouns stay in original language.
- PRIORITIZE hidden gems over mainstream ideas. At least 6 out of 10 ideas MUST be in niches with LOW competition (few or no direct competitors). For each idea, include a "competition_level" field: "low" / "medium" / "high" and explain why.
- At least 3 out of 10 ideas MUST be "future bets" — areas with emerging demand that will grow significantly in the next 6-18 months (new regulations, tech shifts, growing developer needs). For each such idea, include a "growth_signal" field explaining the trend.
---END SEARCHER PROMPT---

Parse the searcher's response as JSON array of 10 ideas. If parse fails, ask the searcher to fix format.

## Step 3: Five Judges (5 Agents IN PARALLEL)

Launch **5 agents simultaneously** (all in a single message, model: "sonnet"). Each agent receives ALL 10 ideas and scores them on ONE criterion.

**IMPORTANT:** Pass the full 10-idea JSON to each judge. Each judge must return scores for ALL 10 ideas.

### Judge 1: Revenue Realism (weight: 0.25)

---BEGIN JUDGE 1 PROMPT---
You are a revenue analysis expert. Score each of these 10 income ideas on a scale of 1-10.

**Scoring criteria — REVENUE REALISM:**
- Are there verified cases of similar products earning this much? (USE WebSearch to verify)
- How realistic is the monetization model?
- Can it reach $8,333/month within 12 months?
- Is there a paying market for this?
- How strong is the evidence of demand?

10 = proven model, many examples earning $8K+/mo, strong market demand
5 = some examples exist but revenue unclear, moderate demand
1 = no evidence anyone earns this much, speculative market

USE WebSearch to verify revenue claims for at least the top 3-4 most promising ideas.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 7, "justification": "1-2 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 1 PROMPT---

### Judge 2: Time & Effort (weight: 0.25)

---BEGIN JUDGE 2 PROMPT---
You are a project effort estimation expert. Score each of these 10 income ideas on a scale of 1-10.

**Scoring criteria — TIME & EFFORT:**
- Can it be built/started with 20 hours/week?
- How long until first dollar earned?
- Does it require constant availability (support, instant replies)?
- Can Claude Code automate the repetitive parts?
- How fast is the MVP (considering $100 budget)?
- Is ongoing maintenance manageable at 20 hrs/week?

10 = start earning in 1-2 weeks, 20 hrs/week is plenty, minimal support needed
5 = 1-2 months to first revenue, 20 hrs/week is tight but doable
1 = 6+ months before any revenue, needs full-time effort, constant support

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 7, "justification": "1-2 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 2 PROMPT---

### Judge 3: Technical Fit (weight: 0.20)

---BEGIN JUDGE 3 PROMPT---
You are a technical feasibility expert. Score each of these 10 income ideas on a scale of 1-10.

**Scoring criteria — TECHNICAL FIT:**
- Does it match JS/Node.js/Python skills?
- Can Claude Code handle 80-90% of the coding work?
- Does it require creativity (UI design, content writing, branding)?
- Does it require English communication with clients?
- Can it run on $100/month infrastructure?
- Are there free/cheap deployment options (Vercel, Railway, Cloudflare)?

10 = perfect skill match, Claude Code does almost everything, no creativity needed, no English calls
5 = some skill gaps but learnable, Claude Code helps but needs manual work too
1 = requires different skills, lots of creative/manual work, English client communication mandatory

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 7, "justification": "1-2 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 3 PROMPT---

### Judge 4: Competition & Barriers (weight: 0.15)

---BEGIN JUDGE 4 PROMPT---
You are a market competition analyst. Score each of these 10 income ideas on a scale of 1-10.

**Scoring criteria — COMPETITION & BARRIERS:**
- How saturated is this market? (USE WebSearch to check competitors)
- What is the barrier to entry?
- Does using Claude Code as the primary dev tool provide a competitive edge?
- Are there underserved niches or segments?
- Can a solo dev compete without a marketing budget?
- Is the market winner-take-all or does it support many small players?

10 = low competition, easy entry, Claude Code gives clear edge, room for small players
5 = moderate competition, some differentiation possible
1 = dominated by big players, high investment needed, no room for newcomers

USE WebSearch to check competition for at least the top 3-4 ideas.

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 7, "justification": "1-2 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 4 PROMPT---

### Judge 5: Sustainability & Scale (weight: 0.15)

---BEGIN JUDGE 5 PROMPT---
You are a business sustainability expert. Score each of these 10 income ideas on a scale of 1-10.

**Scoring criteria — SUSTAINABILITY & SCALE:**
- Is this one-time income or recurring revenue?
- Can revenue grow WITHOUT proportional time increase?
- What are the risks (API changes, platform dependency, regulation)?
- Does it build an asset (product, customer base, brand)?
- Can it eventually generate passive or semi-passive income?
- Is there vendor lock-in risk?

10 = recurring revenue, scales well, builds lasting asset, low platform risk
5 = some recurring element, moderate scaling potential
1 = one-time gig, doesn't scale, high platform dependency, no lasting value

**IDEAS TO EVALUATE:**
{FULL_IDEAS_JSON}

**Return EXACTLY this JSON (no markdown):**
[{"idea_id": 1, "score": 7, "justification": "1-2 sentence explanation"}, ...]

Return scores for ALL 10 ideas. Write justification in Ukrainian.
---END JUDGE 5 PROMPT---

## Step 4: Aggregate & Rank

Parse all 5 judge responses. For each idea compute:

```
total = (revenue * 0.25) + (time * 0.25) + (tech_fit * 0.20) + (competition * 0.15) + (sustainability * 0.15)
```

Sort ideas by `total` descending. Assign `rank` 1-10.

Build the final results object:
```json
{
  "run_id": RUN_ID,
  "date": "TODAY",
  "ideas": [
    {
      "rank": 1,
      "name": "...",
      "category": "...",
      "description": "...",
      "monetization": "...",
      "monthly_potential": "...",
      "time_to_first_revenue": "...",
      "real_examples": "...",
      "tech_stack": "...",
      "claude_code_role": "...",
      "scores": {
        "revenue_realism": {"score": 8, "justification": "..."},
        "time_effort": {"score": 7, "justification": "..."},
        "technical_fit": {"score": 9, "justification": "..."},
        "competition": {"score": 6, "justification": "..."},
        "sustainability": {"score": 7, "justification": "..."}
      },
      "total_score": 7.55
    }
  ]
}
```

## Step 5: Save to Excel

1. Write the results JSON to `{DATA_DIR}/run_{RUN_ID}.json`
2. Run:
```bash
python {DATA_DIR}/generate_excel.py --data {DATA_DIR}/run_{RUN_ID}.json --output {EXCEL}
```

## Step 6: Update History

Read `{HISTORY}`, append new run:
```json
{
  "runs": [
    ...existing,
    {
      "run_id": RUN_ID,
      "date": "TODAY",
      "ideas": ["idea name 1", "idea name 2", ...]
    }
  ]
}
```
Write back to `{HISTORY}`.

## Step 7: Display Results

Show TOP-5 ideas as a table:

| # | Idea | Category | $/mo | Time to $ | Score |
|---|------|----------|------|-----------|-------|
| 1 | ...  | ...      | ...  | ...       | 7.55  |

For each TOP-5 idea, show a 2-3 line summary:
- What it is and how to monetize
- Why it's realistic for your profile
- Suggested first step

Then say: `Full results saved to: {EXCEL}`

## Error Handling

- If searcher returns <10 ideas: accept what you got, note gap
- If a judge fails to return valid JSON: parse what you can, score missing items as 5
- If Excel script fails: save raw JSON as fallback, report error
- If WebSearch fails in an agent: agent should try alternative search queries
