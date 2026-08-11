-- ============================================================================
-- 0018 — token_approval_anomaly detector rule (post-MVP roadmap A.10)
--
-- Adds the `token_approval_anomaly` alert_rule_name enum value. The rule is
-- tx-triggered: it reads the SPL Token `approve` / `approve_checked`
-- instructions the parser now decodes (persisted as `parsed_args._approvals`)
-- and fires when the agent grants a delegate it has not approved in the last
-- 30 days, or grants an unlimited (u64::MAX) allowance to anyone. An approval
-- moves no funds, so no balance-derived rule can see it — the drain arrives in
-- a later transaction the agent never signs.
--
-- Backwards compatible: existing rows and queries are unaffected.
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'token_approval_anomaly';
