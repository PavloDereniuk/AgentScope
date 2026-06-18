-- ============================================================================
-- 0015 — priority_fee_spike detector rule (post-MVP roadmap A.8)
--
-- Adds the `priority_fee_spike` alert_rule_name enum value. The rule fires
-- when a transaction's fee exceeds N × the 24h median fee for the SAME
-- program on this agent — catching silent ComputeBudget overpay bugs that
-- gas_spike (which uses the agent-wide median) may miss when one program
-- consistently overpays relative to its own historical baseline.
--
-- Backwards compatible: existing rows and queries are unaffected.
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'priority_fee_spike';
