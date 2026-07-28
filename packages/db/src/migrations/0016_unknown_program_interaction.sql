-- ============================================================================
-- 0016 — unknown_program_interaction detector rule (post-MVP roadmap A.9)
--
-- Adds the `unknown_program_interaction` alert_rule_name enum value. The rule
-- fires the first time an agent signs a transaction touching a program that is
-- neither on the parser's curated known-program whitelist nor in the agent's
-- own history for the configured lookback window (default 30 days). Severity
-- escalates from warning to critical when SOL or SPL tokens leave the wallet
-- in that same transaction — the fingerprint of a wallet drain.
--
-- Backwards compatible: existing rows and queries are unaffected.
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'unknown_program_interaction';
