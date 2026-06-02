-- ============================================================================
-- 0014_rls_all_partitions_and_func_hardening.sql
--
-- Two Supabase advisor (security linter) fixes that db:push can never apply,
-- because neither is expressible in the drizzle schema:
--
--   1. RLS on EVERY partition of agent_transactions — idempotently, for all
--      partitions that exist now (the initial 2026_04..2026_09 + _default set
--      from migration 0001/0002, plus any months already rolled forward by
--      apps/ingestion/src/partition-maintenance.ts). Migration 0010 enabled
--      RLS on the initial six, but a db:push-based prod history skips raw SQL,
--      so prod partitions were left RLS-disabled — Supabase PostgREST exposes
--      each partition as its own /rest/v1/<name> endpoint, and without RLS an
--      anon/authenticated caller bypasses tx_owner_access. This loop closes
--      the gap for the whole current set in one shot and is safe to re-run.
--
--      No policies are added: RLS-enabled + no-policy = default-deny for
--      non-BYPASSRLS roles on direct partition access, while queries through
--      the parent table still flow through tx_owner_access. The API and
--      ingestion roles bypass RLS, so they are unaffected.
--
--   2. Pin search_path on current_user_id() — the helper RLS policies call on
--      every row. A mutable search_path is a function-hijack vector (Supabase
--      linter "Function Search Path Mutable"). The body only touches
--      pg_catalog objects (current_setting, NULLIF, the uuid cast), which is
--      always implicitly searched, so an empty search_path is correct.
--
-- The runtime counterpart for FUTURE partitions lives in
-- ensureFuturePartitions (it now ENABLEs RLS right after CREATE), so this
-- regression cannot reappear month over month.
-- ============================================================================

DO $$
DECLARE
  child regclass;
BEGIN
  FOR child IN
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent = 'public.agent_transactions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', child);
  END LOOP;
END $$;
--> statement-breakpoint

ALTER FUNCTION "current_user_id"() SET search_path = '';
