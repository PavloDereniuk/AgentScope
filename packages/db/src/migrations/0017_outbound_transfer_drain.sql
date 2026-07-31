-- ============================================================================
-- 0017 — outbound_transfer_drain detector rule (post-MVP roadmap A.11)
--
-- Adds the `outbound_transfer_drain` alert_rule_name enum value. The rule is
-- cron-triggered: it sums the SOL leaving the wallet for addresses the agent
-- has not paid in the last 30 days over a 15-minute sliding window, and fires
-- when that sum exceeds a share of the balance the wallet held when the window
-- opened (default 25%, critical at 2×). Catches the slow drain that per-tx
-- rules miss because no single transfer looks wrong.
--
-- Backwards compatible: existing rows and queries are unaffected.
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'outbound_transfer_drain';
