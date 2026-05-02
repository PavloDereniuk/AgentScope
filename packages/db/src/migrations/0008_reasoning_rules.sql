-- ============================================================================
-- 0008 — reasoning-aware detector rules (Epic 17)
--
-- Adds three new alert_rule_name enum values for rules that cross-check
-- on-chain transactions against the reasoning span tree:
--
--   * decision_swap_mismatch — MAKE_DECISION span's intent (action /
--     amount_sol) diverges from EXECUTE_SWAP / parsed jupiter.swap. Catches
--     "agent said one thing, did another" — agent-kit bugs, prompt drift.
--
--   * stale_oracle — ANALYZE_MARKET market.price_usd diverges from
--     MAKE_DECISION decision.price_usd by more than threshold within the
--     same trace. Catches stale price snapshots and oracle manipulation.
--
--   * ghost_execution — span flagged as EXECUTE_SWAP with status=ok but
--     no agent_transactions row matching the span's tx_signature within
--     the configured window. Catches lost confirmations and dropped txs.
--
-- ALTER TYPE ... ADD VALUE is committed atomically per statement and is
-- backwards-compatible: existing rows and queries are unaffected. The new
-- values cannot be used inside the same transaction that adds them, hence
-- each in its own ALTER (Postgres requirement, not a Drizzle limitation).
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'decision_swap_mismatch';
--> statement-breakpoint
ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'stale_oracle';
--> statement-breakpoint
ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'ghost_execution';
