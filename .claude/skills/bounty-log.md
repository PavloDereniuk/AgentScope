---
name: bounty-log
description: "Log bounty outcomes for ROI tracking and scoring calibration. Shows earnings summary. Triggers: 'log bounty result', 'bounty outcome', 'bounty ROI', 'результат баунті'."
user-invocable: true
argument-hint: "\"<name>\" <earned-usd> <hours> | --stats"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(node *)
---

# Bounty Logger — Outcome Tracker

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **BOUNTY_DIR**: `WORKDIR/.bounty`
- **DATA_FILE**: `BOUNTY_DIR/history.json`

## Init

Ensure directory exists: `node -e "require('fs').mkdirSync('.bounty',{recursive:true})"`

## Modes

Parse `$ARGUMENTS`:
- **Log** (default): `"<name>" <earned-usd> <hours-spent>` — record an outcome
- **Stats**: `--stats` flag — show summary of all outcomes without logging

All three parameters (name, earned, hours) are required for Log mode. If any are missing, ask.

---

## Log Mode

1. Read DATA_FILE (create `{"found":[],"outcomes":[]}` if missing).
2. Find matching entry in `found[]` by name (fuzzy match OK — partial, case-insensitive). This links prediction with outcome.
3. Append to `outcomes[]`:
   ```json
   {
     "name": "<name>",
     "earned": <earned>,
     "hours": <hours>,
     "actualROI": <earned / hours>,
     "date": "TODAY",
     "platform": "<from matched found[] entry, or null>",
     "predictedScore": <totalScore from matched found[] entry, or null>
   }
   ```
4. Write back.
5. **Update learned data** (if `BOUNTY_DIR/learned/learned.json` exists): if `earned > 0`, add platform to `userSignals.outcomes.successful[]` (dedup). If `earned == 0 && hours > 0`, add platform to `userSignals.outcomes.unsuccessful[]` (dedup). If file missing → skip.
6. Print outcome table (see format below).
7. If 3+ outcomes exist, print calibration analysis.

---

## Stats Mode

1. Read DATA_FILE. If no outcomes, print "No outcomes logged yet" and **exit**.
2. Print outcome table and calibration analysis.

---

## Output Format

```
BOUNTY OUTCOMES — ROI Tracker
=============================================
Name                Earned  Hours   $/hr
---------------------------------------------
<name>              $500    4.0h    $125/hr
<name>              $100    2.0h    $50/hr
---------------------------------------------
TOTAL               $600    6.0h    $100/hr avg
=============================================
```

## Calibration Analysis (if 3+ outcomes)

Compare predicted scores (from `found[]` totalScore at time of spotting) vs actual ROI:
- Normalize actual $/hr to 0-100: $200+/hr=95, $100/hr=80, $50/hr=65, $20/hr=45, $5/hr=25, $0=10
- Calculate average bias: predicted - actual_normalized
- Per-platform breakdown if 2+ outcomes from same platform
- Print:

```
CALIBRATION (N outcomes):
  Avg predicted score: XX
  Avg actual (normalized): XX
  Bias: +/-XX (optimistic/pessimistic)
  Per-platform: [Platform] bias=X (N outcomes)
  Recommendation: /bounty-hunt should adjust ROI scores by -/+X
```
