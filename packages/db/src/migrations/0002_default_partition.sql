-- ============================================================================
-- 0002_default_partition.sql
--
-- Add a DEFAULT partition to agent_transactions so rows with block_time
-- outside the predefined monthly ranges (2026-04 through 2026-09) are
-- captured instead of rejected with "no partition found".
--
-- This is needed for historical backfill: when a new agent is registered,
-- the ingestion worker fetches the last 50 historical transactions which
-- may have block_times months or years in the past.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "agent_transactions_default" PARTITION OF "agent_transactions" DEFAULT;
