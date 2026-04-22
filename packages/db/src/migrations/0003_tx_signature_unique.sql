-- ============================================================================
-- 0003_tx_signature_unique.sql
--
-- Enforce idempotent transaction ingestion at the DB level.
--
-- Bug (review #12): `agent_transactions.signature` had only a plain index,
-- and `persist.ts` inserted without ON CONFLICT. Every backfill pass
-- (which runs on every ingestion restart) re-inserted the same signatures,
-- producing 7× copies per historical tx in live data.
--
-- Fix:
--   1. Dedupe existing rows — keep the oldest (MIN(id)) per agent/sig.
--   2. Add a UNIQUE index on (agent_id, signature, block_time).
--      Uniqueness is per-agent (not global) so two users watching the
--      same wallet each keep their own row. `block_time` is included
--      because Postgres requires every unique constraint on a
--      partitioned table to cover the partition key.
--   3. Drop the redundant plain `tx_signature_idx` only after the
--      unique one is live — avoids the window where no `signature`
--      index exists (lookups by sig would seq-scan every partition).
--
-- Follow-up in app code: persist.ts switches to `ON CONFLICT DO NOTHING`
-- targeting (agent_id, signature, block_time).
--
-- All statements are guarded with IF [NOT] EXISTS so partial retries are
-- safe: if the migration crashes between breakpoints (e.g. on duplicate
-- rows added since step 1), a re-run picks up where it left off.
-- ============================================================================

-- Step 1: dedupe. Keep row with smallest id per (agent_id, signature, block_time).
-- Idempotent — repeat runs are no-ops once duplicates are cleared.
DELETE FROM "agent_transactions" a
USING "agent_transactions" b
WHERE a.signature = b.signature
  AND a.agent_id = b.agent_id
  AND a.block_time = b.block_time
  AND a.id > b.id;
--> statement-breakpoint

-- Step 2: create the unique index BEFORE dropping the old one so there is
-- no window without an index on `signature`. `IF NOT EXISTS` lets re-runs
-- skip when already applied.
CREATE UNIQUE INDEX IF NOT EXISTS "tx_agent_signature_time_unique"
  ON "agent_transactions" ("agent_id", "signature", "block_time");
--> statement-breakpoint

-- Step 3: `tx_agent_signature_time_unique` leads with `agent_id`, so a
-- `WHERE signature = ?` lookup can't use it as a prefix. We keep a
-- signature-only index for the single-tx API route; name kept stable so
-- later migrations can reference it.
CREATE INDEX IF NOT EXISTS "tx_signature_idx"
  ON "agent_transactions" ("signature");
