-- ============================================================================
-- 0013 — tx_rate_anomaly detector rule (post-MVP roadmap A.3, v0.4.2)
--
-- Adds the `tx_rate_anomaly` alert_rule_name enum value. The rule fires when
-- an agent's mean tx rate over a 5-minute sliding window exceeds the cap
-- (default 30/min). Cron-triggered — runs on the same 60s cycle as
-- drawdown / error_rate / low_balance. Counts BOTH success and failed tx
-- (a stuck retry loop burns priority fees regardless of confirmation).
--
-- Backwards compatible: existing rows and queries are unaffected. The new
-- value cannot be referenced inside the same transaction that adds it, so
-- it gets its own ALTER (Postgres requirement, not Drizzle).
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'tx_rate_anomaly';
