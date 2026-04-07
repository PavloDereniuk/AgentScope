# Scoring Criteria — Hybrid System

Deterministic formulas (computed by `score-calc.mjs`) + LLM assessment for judgment-based criteria.

## Weights

| Criterion | Weight | Key | Method |
|-----------|--------|-----|--------|
| Achievability | 30% | achieve | LLM + freshness/competition (from script) |
| ROI | 25% | roi | LLM + competition adj (from script) |
| Claude Code Fit | 20% | claude | LLM + tech stack adj (from script) |
| Payout Probability | 15% | payout | Script base + LLM flags |
| Strategic Value | 10% | strategic | LLM + user signal adj |

**Formula:** `total = achieve*0.30 + roi*0.25 + claude*0.20 + payout*0.15 + strategic*0.10`

**Ranking:** `rankScore = total * confidenceWeight` — prevents unverified items from dominating.

---

## What score-calc.mjs Provides (in `_det` field)

Each item gets a `_det` object with pre-calculated values:
- `deadlineScore` — used as component within achievability
- `payoutBase` — starting point for payout criterion (30-88)
- `competition` — `{level, adj, source, submissionCount}` to apply to ROI
- `techStackAdj` — bonus/penalty for Claude Code Fit (-10 to +5)
- `calibrationAdj` — bias correction from outcomes data
- `confidenceWeight` — 0-1 multiplier for ranking
- `freshnessAdj` — bonus/penalty based on how recently posted (-15 to +10)
- `sweetSpotAdj` — bonus for reward in sweet spot range ($200-$2000): +8

---

## NEW: Achievability (30%) — HIGHEST WEIGHT

This is the most important criterion. Can the user realistically complete this and earn the reward?

### Scoring guide

| Scenario | Score |
|----------|-------|
| Clear deliverable, 1-3 days with CC, low competition (<10 submissions) | 90-100 |
| Clear deliverable, 3-7 days with CC, moderate competition (10-30) | 70-89 |
| Defined scope, ~1 week, medium competition (30-100) | 50-69 |
| Vague scope, 1-2 weeks, high competition (100+) | 30-49 |
| Ongoing program, no clear deliverable, lottery-style | 10-29 |
| Bug bounty running 1+ years, thousands of researchers | 0-15 |

### Key factors:
- **Submission count** (from API where available): direct competition indicator
- **Deadline proximity**: tight deadline = fewer competitors = higher achievability
- **Task clarity**: "Build X" >> "Find bugs in Y"
- **Freshness**: posted <7 days ago → +10, 7-30 days → +5, 1-6 months → 0, 6+ months → -10, 1+ years → -15
- **Estimated hours**: <10h → +5, 10-30h → 0, 30-60h → -5, 60h+ → -15
- **Bug bounty penalty**: type=bug-bounty AND ongoing (no deadline) → automatic cap at 15

**Final achieve = clamp(llm_base + freshnessAdj + deadlineBonus + competitionAdj, 0, 100)**

Where `deadlineBonus`: 3-7 days → +10, 7-14 days → +5, 14-30 → 0, no deadline → -5

---

## DETERMINISTIC: Payout Base — from script

| Platform tier | Base |
|--------------|------|
| Tier 1 + escrow (C4, Sherlock, Immunefi, HackerOne, CodeHawks, Cantina) | 88 |
| Tier 1, no escrow (Superteam, Bugcrowd) | 72 |
| Tier 2 established (Devpost, DoraHacks, Hats, Intigriti, Secure3, Spearbit) | 65 |
| Tier 2 newer (Bountycaster, OnlyDust, Gitcoin) | 55 |
| Tier 3 (Layer3, Zealy, Galxe, Questbook) | 42 |
| GitHub issues | 50 |
| Unknown platform | 30 |

### LLM modifiers (apply on top of base)

**Red flags** (each -10 to -15):
- No escrow: -15 | Anonymous team: -12 | Vague terms ("TBA"): -10
- New protocol no TVL: -10 | Pay in illiquid token: -15 | Suspiciously high reward: -10

**Green flags** (bonus):
- Platform historically paid (from outcomes): +8 | Known backing (a16z, Paradigm): +5 | Public escrow: +5
- Verified sponsor on platform: +3

**Final payout = clamp(payoutBase + LLM_modifiers, 5, 100)**

---

## DETERMINISTIC: Competition Adjustment — from script

Applied to ROI and Achievability scores. Uses participant/submission count if available from API, otherwise estimates.

| Submissions/Participants | Level | ROI adj | Achieve adj |
|--------------------------|-------|---------|-------------|
| <5 | Very Low | +5 | +10 |
| 5-15 | Low | 0 | +5 |
| 15-50 | Medium | -5 | 0 |
| 50-150 | High | -12 | -10 |
| 150-500 | Very High | -18 | -15 |
| 500+ / unknown ongoing | Extreme | -22 | -20 |

---

## Reward Sweet Spot Adjustment

Tasks in the sweet spot ($200-$2000) get a scoring boost because they're achievable and worth the effort:

| Reward range | Adjustment |
|-------------|------------|
| $0-$50 | -5 (too small) |
| $50-$200 | 0 |
| $200-$2,000 | +8 (sweet spot) |
| $2,000-$5,000 | +3 |
| $5,000-$20,000 | 0 |
| $20,000-$100,000 | -3 (high competition likely) |
| $100,000+ | -8 (lottery territory for most) |
| TBD/unknown | -5 |

Applied to ROI score.

---

## LLM-ASSESSED: ROI (25%)

Assess complexity, realistic hours, hidden costs. Factor Claude Code 4-8x speedup.

| Effective $/hr | Score |
|----------------|-------|
| $200+/hr | 90-100 |
| $50-200/hr | 70-89 |
| $20-50/hr | 50-69 |
| $5-20/hr | 30-49 |
| <$5/hr | 0-29 |

Caps: "Potential airdrop" unknown → max 30. "TBA rewards" → max 35. Points/XP only → max 20.

**Final ROI = clamp(roi_base + _det.competition.adj + _det.sweetSpotAdj + _det.calibrationAdj, 0, 100)**

---

## LLM-ASSESSED: Claude Code Fit (20%)

**Excellent (85-100):** smart contract dev, SDK/API building, full-stack apps, code review, tooling, integrations, dashboards, data pipelines, scripts, documentation-from-code.
**Good (65-84):** security audit of specific codebase, hackathon project, CLI tool, browser extension.
**Mixed (40-64):** code + non-code deliverables, unfamiliar framework, significant research component.
**Poor (0-39):** GPU/ML training, Figma/design, hardware, video production, physical tasks, content-only (tweets/threads), KYC-gated.

**Final = clamp(llm_score + _det.techStackAdj, 0, 100)**

---

## LLM-ASSESSED: Strategic Value (10%)

| Scenario | Score |
|----------|-------|
| Recurring income (platform with regular bounties) | 80-95 |
| Portfolio/reputation on known platform | 60-80 |
| Ecosystem access (tokens, network) | 50-70 |
| Skill building in high-demand area | 40-60 |
| One-time only, no follow-up | 20-40 |

User signal adjustment: tracked platforms → +3, high-ignored → -3.

---

## Confidence Weight (from script)

| Source | Base confidence |
|--------|----------------|
| API with schema | 0.90 |
| WebFetch item page | 0.75 |
| WebSearch snippet | 0.50 |
| Agent, unverified | 0.35 |

Adjusted by verification: `true` → max(conf, 0.85), `partial` → min(conf, 0.70), `suspect` → min(conf, 0.40).

---

## Calibration Anchors

Average score across items should be 40-65.

| Example | Total | Notes |
|---------|-------|-------|
| Superteam $500 bounty, clear spec, 5 submissions, 2-day CC task | **88** | Ideal target |
| Superteam $1000 bounty, SDK work, 15 submissions | **82** | Sweet spot |
| Devpost $5K hackathon, 2 weeks, online | **68** | Good if fits |
| GitHub $200 bounty, clear issue, open PR | **75** | Quick win |
| Gitcoin grant round, $50K pool | **50** | Uncertain |
| Immunefi $100K+ ongoing bug bounty | **18** | Lottery, deprioritize |
| C4 $30K pool, ~200 auditors | **45** | High competition |
| Galxe quest, XP only | **15** | Not worth time |
| Unknown testnet farming | **10** | Speculation |

## Compact Output (per item)

```
[1] Build Solana Indexer — $1,200 | superteam
    Ach:90 ROI:75 CC:95 Pay:72 Str:60 -> TOTAL: 82 | rank: 74 | Comp: Low (3 subs) | conf:90% | verified
```
