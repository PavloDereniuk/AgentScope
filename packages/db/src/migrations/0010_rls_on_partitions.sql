-- ============================================================================
-- 0010_rls_on_partitions.sql
--
-- Enable RLS on every child partition of agent_transactions.
--
-- Postgres does NOT inherit RLS state from a partitioned parent to its
-- partitions: each partition is a separate table object and must be flipped
-- to row-security on its own. Policies defined on the parent ARE applied
-- when queries hit the parent (so app code reading `agent_transactions`
-- stays correctly filtered), but Supabase PostgREST exposes every public
-- table — including each partition — as its own /rest/v1/<name> endpoint.
-- Without RLS on the partitions, an anon/authenticated caller can hit
-- /rest/v1/agent_transactions_2026_04 and bypass tx_owner_access entirely.
-- This migration closes that gap (Supabase linter rule 0013).
--
-- No policies are added on the partitions: with RLS enabled and no policies,
-- non-BYPASSRLS roles get default-deny (zero rows) on direct access, which
-- is what we want. Queries via the parent table continue to flow through
-- tx_owner_access. The ingestion worker uses service_role (BYPASSRLS) so
-- writes are unaffected.
--
-- Reminder: when a new monthly partition is added post-MVP (e.g.
-- agent_transactions_2026_10), apply the same ALTER TABLE ... ENABLE ROW
-- LEVEL SECURITY to it before any production traffic lands.
-- ============================================================================

ALTER TABLE "agent_transactions_2026_04" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_2026_05" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_2026_06" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_2026_07" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_2026_08" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_2026_09" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions_default" ENABLE ROW LEVEL SECURITY;
