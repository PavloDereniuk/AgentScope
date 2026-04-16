---
name: code-review
description: "Code review a pull request, local changes, or entire folder/files without git. Triggers: '/code-review', 'review PR', 'review code', 'зроби рев''ю'."
user-invocable: true
argument-hint: "[PR_NUMBER | BRANCH | --staged | --last-commit | --path PATH] [--repo OWNER/REPO] [--focus security|performance|logic|style|all] [--severity critical|all] [--format summary|detailed|checklist] [--ext ts,js,rs,...] [--exclude node_modules,dist,...]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash(git *)
  - Bash(gh *)
  - Bash(node *)
  - Bash(mkdir *)
  - Agent
  - WebFetch
---

# Code Review

Comprehensive AI-powered code review for PRs, branches, and local changes.

## Context

- **WORKDIR**: !`node -e "console.log(process.cwd())"`
- **TODAY**: !`node -e "console.log(new Date().toISOString().slice(0,10))"`
- **OUTPUT_MD**: `WORKDIR/output/md/code-review`

## Parameters

Parse from `$ARGUMENTS`:

| Param | Default | Description |
|---|---|---|
| `target` | `--staged` | What to review: PR number, branch name, `--staged`, `--last-commit`, `--path PATH` |
| `--repo` | current repo | GitHub repo in `OWNER/REPO` format |
| `--path` | none | Path to folder or file to review (no git required) |
| `--ext` | auto-detect | File extensions to include: `ts,js,rs,py` |
| `--exclude` | `node_modules,dist,.git,target,build,coverage` | Folders to exclude |
| `--focus` | `all` | Focus area: `security`, `performance`, `logic`, `style`, `all` |
| `--severity` | `all` | Filter: `critical` (only blockers) or `all` |
| `--format` | `summary` | Output: `summary`, `detailed`, `checklist` |
| `--save` | false | Save review to `OUTPUT_MD` |

## Step 0 — Init

```bash
mkdir -p output/md/code-review
```

Read the fixes history file **before** examining any code. This file records all issues
already fixed in previous review sessions, so you don't re-report them unless there's
evidence of a regression:

```
Read: output/md/code-review/fixes-history.md
```

If the file doesn't exist yet, skip this step and continue.

When presenting findings, tag any issue that matches an already-fixed entry as
**[regression — previously fixed YYYY-MM-DD]** rather than a new finding.

## Step 1 — Determine Target & Get Diff

Based on `target` parameter:

### PR Number (e.g., `123`)
```bash
gh pr view {PR_NUMBER} --repo {REPO} --json title,body,author,baseRefName,headRefName,files,additions,deletions,changedFiles
gh pr diff {PR_NUMBER} --repo {REPO}
```

### Branch name (e.g., `feature/my-branch`)
```bash
git log main..{BRANCH} --oneline
git diff main...{BRANCH}
```

### `--staged` (default)
```bash
git diff --cached
git diff --cached --stat
```

### `--last-commit`
```bash
git log -1 --format="%H %s"
git diff HEAD~1..HEAD
```

### `--path PATH` (folder/file review, no git required)

Review an entire folder or specific file(s). No git needed.

1. **Discover files** — use Glob to find source files:
   - If `--ext` provided: `**/*.{ext1,ext2}`
   - If not: auto-detect by scanning for common extensions (`ts,tsx,js,jsx,mjs,rs,py,go,sol,toml,json`)
   - Always exclude: `node_modules`, `dist`, `.git`, `target`, `build`, `coverage`, `__pycache__`, `.next`, plus any `--exclude` values

2. **Assess scope** — count files and estimate total lines:
   - **Small** (<=10 files, <=1000 lines): review all files directly
   - **Medium** (<=30 files, <=5000 lines): review all files, use Agent for parallel processing by file group
   - **Large** (>30 files or >5000 lines): 
     - First scan project structure and summarize architecture
     - Then use multiple Agent subagents in parallel, each reviewing a group of related files
     - Each agent reports findings independently
     - Merge and deduplicate findings at the end

3. **Read each file fully** and apply the Review Checklist (Step 2)

4. **Additional checks for folder review**:
   - [ ] Project structure and organization
   - [ ] Dependency health (`package.json`, `Cargo.toml` — outdated/vulnerable deps)
   - [ ] Config files (tsconfig, eslint, etc.) — reasonable settings
   - [ ] Missing essentials: `.gitignore`, error handling entry point, types/interfaces

If no files found, tell the user and stop.

### Multiple paths

`--path` accepts comma-separated paths:
```
/code-review --path src/lib,src/utils --ext ts
```

If diff is empty (for git modes), tell the user and stop.

## Step 2 — Analyze Changes

For each changed file, read the full file (not just the diff) to understand context.

### Review Checklist

Apply all categories unless `--focus` narrows it:

#### Security
- [ ] Injection vulnerabilities (SQL, command, XSS)
- [ ] Hardcoded secrets, API keys, private keys
- [ ] Unsafe deserialization
- [ ] Missing input validation at boundaries
- [ ] Insecure crypto or randomness
- [ ] For Solana/Web3: unchecked accounts, missing signer checks, PDA validation

#### Logic
- [ ] Off-by-one errors, boundary conditions
- [ ] Race conditions, concurrency issues
- [ ] Null/undefined handling
- [ ] Error handling — swallowed errors, missing catches
- [ ] State mutations with side effects
- [ ] For Solana: incorrect account ordering, lamport balance issues

#### Performance
- [ ] Unnecessary allocations in loops
- [ ] N+1 queries or unbounded iterations
- [ ] Missing caching opportunities
- [ ] Large unnecessary dependencies
- [ ] For Solana: compute budget, unnecessary CPI calls

#### Style & Maintainability
- [ ] Naming clarity
- [ ] Dead code, unused imports
- [ ] Duplicated logic that should be extracted
- [ ] Missing types (TypeScript)
- [ ] Overly complex functions (cognitive complexity > 15)

#### AgentScope-specific
- [ ] Zod validation on all API boundaries (`@hono/zod-validator`)
- [ ] No `any` types — TS strict enforced
- [ ] Drizzle queries — no raw SQL unless absolutely necessary
- [ ] OTel spans properly closed (no leaked spans)
- [ ] RLS policies not bypassed (no `service_role` key in frontend)
- [ ] No secrets in env vars committed to repo
- [ ] Biome rules respected (no lint suppressions without comment)

## Step 3 — Generate Review

### Severity Levels

| Level | Icon | Meaning |
|---|---|---|
| Critical | :red_circle: | Must fix — bugs, security holes, data loss |
| Warning | :orange_circle: | Should fix — logic issues, bad patterns |
| Suggestion | :blue_circle: | Nice to have — style, readability |
| Positive | :green_circle: | Good practice worth noting |

### Output Format

#### Summary (default)
```
## Code Review: {target}
**Files changed**: N | **Additions**: +N | **Deletions**: -N

### Findings

:red_circle: **Critical** (N)
- [file:line] Description

:orange_circle: **Warning** (N)
- [file:line] Description

:blue_circle: **Suggestion** (N)
- [file:line] Description

:green_circle: **Positive** (N)
- [file:line] Good practice noted

### Verdict
[APPROVE | REQUEST_CHANGES | COMMENT]
Brief summary of overall quality.
```

#### Detailed
Same as summary but with code snippets and fix suggestions for each finding.

#### Checklist
Outputs the review checklist with pass/fail for each item.

## Step 4 — Save (if `--save`)

Save review to `output/md/code-review/review_{TARGET}_{TODAY}.md`

## Step 5 — PR Comment (if reviewing a PR and user confirms)

Ask user if they want to post the review as a PR comment:
```bash
gh pr review {PR_NUMBER} --repo {REPO} --comment --body "..."
```

## Step 6 — Update Fixes History (if fixes were applied)

If the review led to fixes being applied in the same session, append a new dated session
block to `output/md/code-review/fixes-history.md` documenting:
- What was fixed (file path + symptom)
- Why it matters (security impact, data loss, UX bug, etc.)
- The fix approach in one sentence

This keeps the history accurate for future review runs.

## Guidelines

- Be specific: always reference file:line
- Show the problematic code AND the suggested fix
- Don't nitpick formatting if Biome is configured (it is in this project)
- Prioritize findings by severity — lead with critical issues
- For Solana programs: pay extra attention to account validation, signer checks, PDA seeds
- Acknowledge good patterns — review is not just about finding problems
- If the diff is too large (>2000 lines), split review by file groups and use Agent tool for parallel review
- For `--path` mode: focus on the most impactful findings, don't try to list every minor style issue in every file
- For `--path` mode with large projects: start with architecture overview, then deep-dive into critical files (entry points, crypto, auth, state management)
- This is an AgentScope project (Datadog for Solana AI agents) — TypeScript strict, Hono + Drizzle + Postgres backend, React + Vite frontend. Keep that context when assessing findings.
