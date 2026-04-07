# Self-Improvement System

Bounty-hunt improves after every run through a **single combined file**: `.bounty/learned/learned.json`.

Previously 5 separate files, now consolidated to reduce I/O (1 read + 1 write instead of 10).

## File Structure

```json
{
  "version": 3,
  "queries": {
    "immunefi": {
      "queries": {
        "site:immunefi.com bug bounty active 2026": {
          "timesUsed": 5, "totalResults": 18, "avgResults": 3.6,
          "lastUsed": "2026-03-25", "verifiedResults": 12, "dropRate": 0.33
        }
      },
      "customQueries": [],
      "bestQuery": "site:immunefi.com bug bounty active 2026"
    }
  },
  "agents": {
    "discovery-bounties": {
      "totalRuns": 8, "totalItems": 45, "verified": 28,
      "qualityRate": 0.62, "consecutiveZero": 0,
      "lastParseTier": 1,
      "history": [
        {"date": "2026-03-25", "items": 6, "verified": 4, "parseTier": 1}
      ]
    }
  },
  "drops": {
    "urlPatterns": [
      {"pattern": "dorahacks.io/hackathon/", "dropCount": 8, "lastSeen": "2026-03-25", "reason": "SPA empty"}
    ],
    "falsePositiveSignals": [
      "contest completed", "registration closed", "submissions ended",
      "no longer accepting", "this contest has ended", "winners announced"
    ]
  },
  "runs": [
    {
      "date": "2026-03-25", "mode": "default", "platformsSearched": 8,
      "rawResults": 45, "afterDedup": 32, "verified": 25,
      "topScore": 82, "avgScore": 58, "budgetUsed": 38, "budgetLimit": 40
    }
  ],
  "userSignals": {
    "tracked": [],
    "ignored": {"byPlatform": {}, "byType": {}, "byScoreRange": {}},
    "outcomes": {"successful": [], "unsuccessful": []}
  }
}
```

---

## How to Read (Step 0-1)

1. If file missing → skip (first run).
2. If `version < 3` → migrate (see Migration below).
3. **Queries**: sort by `avgResults` desc, use best query. If all `avgResults < 1` over 3+ uses → generate custom query.
4. **Agents**: if `consecutiveZero >= 3` AND `qualityRate < 0.1` → skip agent (unless `--force-agents`). If `qualityRate < 0.3` → add quality warning to prompt.
5. **Drops**: before verifying URL, check `urlPatterns` with `dropCount >= 5` → mark suspect, skip fetch.
6. **Runs**: use for delta report (compare current vs last run).
7. **UserSignals**: `tracked[]` platforms → +3 strategic. High `ignored` → -3 strategic.

---

## How to Write (Step 5)

After run completes, read file (or create fresh), update all sections, write back once.

### Queries
For each platform searched: record query used, raw results, verified results. Update `avgResults`, `dropRate`. If `avgResults < 0.5` over 3+ uses and no custom queries → generate one.

### Agents
For each agent: record items, verified count, parse tier. Update `qualityRate = verified / totalItems` (lifetime). Items=0 → increment `consecutiveZero`. Items>0 → reset to 0.

### Drops
For each dropped item: extract URL pattern (domain + first 2 path segments). Increment or create entry. Add new "closed" signals to `falsePositiveSignals` (dedup).

### Runs
Append: `{date, mode, platformsSearched, rawResults, afterDedup, verified, topScore, avgScore, budgetUsed, budgetLimit}`. Keep last 50.

### UserSignals
Items in 3+ past runs but never tracked → increment `ignored.byPlatform[platform]` and `ignored.byType[type]`.

---

## Migration

### From v1/v2 (separate files) to v3 (combined)

If `learned.json` doesn't exist but individual files do (`query-performance.json`, `agent-performance.json`, `drop-patterns.json`, `run-log.json`, `user-signals.json`):

1. Read each file.
2. Combine into v3 structure:
   - `query-performance.json` `.platforms` → `learned.queries`
   - `agent-performance.json` `.agents` → `learned.agents`
   - `drop-patterns.json` → `learned.drops`
   - `run-log.json` `.runs` → `learned.runs`
   - `user-signals.json` → `learned.userSignals`
3. Write combined `learned.json`.
4. Do NOT delete old files (user may want backup).

---

## Self-Review (printed at end)

```
SELF-REVIEW:
  Data quality: X% survived verification
  Best source: Platform (Y verified)
  Budget: USED/LIMIT
  Suggestion: [one improvement or "none"]
```

Suggestions: "remove platform X (0 results 5 runs)", "agent quality declining", "user never tracks quest type", "budget maxed — increase with --budget", "none".
