---
name: bounty-track
description: "Manage bounty watchlist: add URLs to track, check status of tracked items, remove entries. Triggers: 'track bounty', 'bounty watchlist', 'check watchlist', 'відстежити баунті'."
user-invocable: true
argument-hint: "<url> [name] [--score N] | --check | --remove <url|name>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash(node *)
  - WebFetch
  - WebSearch
---

# Bounty Tracker — Watchlist Manager

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **BOUNTY_DIR**: `WORKDIR/.bounty`
- **DATA_FILE**: `BOUNTY_DIR/watchlist.json`

## Init

Ensure directory exists: `node -e "require('fs').mkdirSync('.bounty',{recursive:true})"`

## Modes

Parse `$ARGUMENTS`:
- **Track** (default): first arg is a URL, optional second arg is a name. `--score N` attaches a hunt score. Add to watchlist.
- **Check**: `--check` or `--watchlist` flag. Check all active items for status updates.
- **Remove**: `--remove <url|name>`. Remove matching item from watchlist.

---

## Track Mode

1. Read DATA_FILE (create `[]` if missing).
2. Check if URL already exists in the list. If duplicate, warn and **exit**.
3. WebFetch the URL to extract:
   - Name (if not provided by user)
   - Deadline (if visible on page)
   - Brief description
4. Append to array:
   ```json
   {
     "url": "<url>",
     "name": "<name>",
     "addedDate": "TODAY",
     "deadline": "<extracted or null>",
     "lastChecked": null,
     "status": "active",
     "score": "<from --score or null>",
     "source": "<'manual' or 'auto-track'>",
     "notes": "",
     "statusHistory": []
   }
   ```
5. Write back.
6. **Update learned data** (if `BOUNTY_DIR/learned/learned.json` exists): append to `userSignals.tracked[]`: `{"name": NAME, "platform": PLATFORM_IF_KNOWN, "score": SCORE_IF_SET, "date": TODAY}`. If file missing → skip.
7. Print: `Added to watchlist (N total): NAME — URL`

---

## Check Mode

1. Read DATA_FILE. If empty or missing, print "Watchlist is empty" and **exit**.
2. For each item with `status: "active"` or `status: "urgent"`:
   a. WebFetch the URL.
   b. Determine from page content if still open/active.
   c. Update status:
      - Still open + deadline < 3 days → `"urgent"`
      - Still open → `"active"`
      - Page shows closed/ended/expired → `"closed"`
      - Fetch failed (404, timeout) → `"unknown"`
   d. Set `lastChecked: "TODAY"`.
   e. Append to `statusHistory`: `{"date": "TODAY", "status": "<new status>"}`.
3. Write updated file.
4. Print report sorted by urgency (urgent first, then active, then closed):

```
WATCHLIST — TODAY (N tracked)
====================================
!! URGENT  Name — deadline in X days
           Score: XX | URL
-- Active  Name — still open
           Score: XX | URL
xx Closed  Name — no longer available
           URL
====================================
```

---

## Remove Mode

1. Read DATA_FILE.
2. Find item matching the argument by URL (exact) or name (case-insensitive partial match).
3. If not found, print "Not found in watchlist" and **exit**.
4. If multiple matches, show them and ask which to remove.
5. Remove from array and write back.
6. Print: `Removed from watchlist: NAME — URL`
