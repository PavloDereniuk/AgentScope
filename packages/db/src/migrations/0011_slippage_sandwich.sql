-- ============================================================================
-- 0011 — slippage_sandwich detector rule (post-MVP roadmap A.1, v0.4.0)
--
-- Adds the `slippage_sandwich` alert_rule_name enum value. The rule fires
-- when a Jupiter swap's actual received amount (from token deltas) is more
-- than N% below the quoted amount embedded in the instruction args. This
-- is the on-chain fingerprint of an MEV sandwich attack: the agent's swap
-- executed at a worse price than the route quoted, typically because a
-- front-running bot moved the pool before the agent's tx landed.
--
-- Backwards compatible: existing rows and queries are unaffected. The new
-- value cannot be referenced inside the same transaction that adds it, so
-- it gets its own ALTER (Postgres requirement, not Drizzle).
-- ============================================================================

ALTER TYPE "public"."alert_rule_name" ADD VALUE IF NOT EXISTS 'slippage_sandwich';
