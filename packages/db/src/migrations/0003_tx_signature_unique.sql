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
--   2. Replace the plain index with a UNIQUE index on
--      (agent_id, signature, block_time).
--      Uniqueness is per-agent (not global) so two users watching the
--      same wallet each keep their own row. `block_time` is included
--      because Postgres requires every unique constraint on a
--      partitioned table to cover the partition key.
--
-- Follow-up in app code: persist.ts switches to `ON CONFLICT DO NOTHING`
-- targeting (agent_id, signature, block_time).
-- ============================================================================

-- Step 1: dedupe. Keep row with smallest id per (agent_id, signature, block_time).
DELETE FROM "agent_transactions" a
USING "agent_transactions" b
WHERE a.signature = b.signature
  AND a.agent_id = b.agent_id
  AND a.block_time = b.block_time
  AND a.id > b.id;
--> statement-breakpoint

-- Step 2: drop the old non-unique index; the new unique one covers
-- `signature` as the second prefix-accessible column, and for the hot path
-- (lookup by signature alone) the planner still does a fast partitioned
-- index scan across child partitions.
DROP INDEX IF EXISTS "tx_signature_idx";
--> statement-breakpoint

-- Step 3: enforce uniqueness going forward.
CREATE UNIQUE INDEX "tx_agent_signature_time_unique"
  ON "agent_transactions" ("agent_id", "signature", "block_time");
--> statement-breakpoint

-- Keep a signature-only lookup index since the new unique index has agent_id
-- as the leftmost column and lookups by signature alone would otherwise
-- scan every partition without a usable prefix.
CREATE INDEX "tx_signature_idx"
  ON "agent_transactions" ("signature");
