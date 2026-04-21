-- ============================================================================
-- 0004_alerts_dedupe_unique.sql
--
-- Enforce idempotent alert creation at the DB level.
--
-- Bug: `alerts.dedupe_key` had only a plain index (alerts_dedupe_idx), and
-- cron.ts called `onConflictDoNothing()` without specifying a target. With
-- no UNIQUE constraint, Postgres had no conflict to detect, so every 60s
-- cron tick inserted a duplicate alert for the same dedupe bucket. Observed
-- 18 stale_agent rows for a single test agent in ~18 min → 18 Telegram
-- messages.
--
-- Fix:
--   1. Dedupe existing rows per (agent_id, rule_name, dedupe_key), keeping
--      the oldest (MIN(id)). Null dedupe_key rows are left alone — the
--      uniqueness constraint does not cover them (Postgres NULLS DISTINCT
--      default).
--   2. Drop the plain index.
--   3. Create a UNIQUE index on (agent_id, rule_name, dedupe_key). NULL
--      dedupe_key bypasses the constraint by default, which matches the
--      schema comment: "not every future rule must participate in dedupe".
--
-- Follow-up in app code: cron.ts, detector-runner.ts, and the seed script
-- now pass `target: [agentId, ruleName, dedupeKey]` to
-- `onConflictDoNothing()` so Postgres can actually match the constraint.
-- ============================================================================

-- Step 1: dedupe existing rows. Keep the oldest row per bucket.
DELETE FROM "alerts" a
USING "alerts" b
WHERE a.agent_id = b.agent_id
  AND a.rule_name = b.rule_name
  AND a.dedupe_key IS NOT NULL
  AND b.dedupe_key IS NOT NULL
  AND a.dedupe_key = b.dedupe_key
  AND a.id > b.id;
--> statement-breakpoint

-- Step 2: drop the plain (non-unique) index.
DROP INDEX IF EXISTS "alerts_dedupe_idx";
--> statement-breakpoint

-- Step 3: enforce uniqueness going forward. Default NULLS DISTINCT semantics
-- mean rows with NULL dedupe_key are always allowed (they do not conflict
-- with each other).
CREATE UNIQUE INDEX "alerts_dedupe_unique"
  ON "alerts" ("agent_id", "rule_name", "dedupe_key");
