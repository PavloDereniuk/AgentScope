-- ============================================================================
-- 0012 — low_balance detector rule (post-MVP roadmap A.2, v0.4.1)
--
-- Adds the `low_balance` alert_rule_name enum value. The rule fires when an
-- agent's wallet SOL balance drops below a configurable threshold (default
-- 0.005 SOL warning, 0.001 SOL critical). Cron-triggered — runs on the same
-- 60s cycle as drawdown/stale_agent, fetching balance via Helius
-- `Connection.getBalance` with a per-wallet TTL cache.
--
-- Backwards compatible: existing rows and queries are unaffected. The new
-- value cannot be referenced inside the same transaction that adds it, so
-- it gets its own ALTER (Postgres requirement, not Drizzle).
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'low_balance';
