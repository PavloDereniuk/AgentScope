-- ============================================================================
-- 0001_rls_and_partition.sql
--
-- Two operations that drizzle-kit cannot emit:
--   1. Convert agent_transactions to a RANGE-partitioned table by block_time
--      (must DROP + CREATE — Postgres has no ALTER TABLE ... PARTITION BY).
--   2. Enable RLS on all tables with session-variable based policies that
--      work without Supabase Auth (we use Privy at the application layer).
--
-- The drizzle schema in src/schema.ts already declares the composite PK
-- (id, block_time) on agent_transactions, so subsequent `db:generate` runs
-- stay idempotent against the partitioned shape.
-- ============================================================================

-- ─── Part 1: Convert agent_transactions to partitioned ────────────────────

DROP TABLE IF EXISTS "agent_transactions" CASCADE;
--> statement-breakpoint

CREATE TABLE "agent_transactions" (
    "id" bigserial NOT NULL,
    "agent_id" uuid NOT NULL,
    "signature" text NOT NULL,
    "slot" bigint NOT NULL,
    "block_time" timestamp with time zone NOT NULL,
    "program_id" text NOT NULL,
    "instruction_name" text,
    "parsed_args" jsonb,
    "sol_delta" numeric(20, 9) NOT NULL DEFAULT '0',
    "token_deltas" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "fee_lamports" bigint NOT NULL DEFAULT 0,
    "success" boolean NOT NULL,
    "raw_logs" text[] NOT NULL DEFAULT ARRAY[]::text[],
    CONSTRAINT "agent_transactions_id_block_time_pk" PRIMARY KEY ("id", "block_time"),
    CONSTRAINT "agent_transactions_agent_id_agents_id_fk"
        FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE CASCADE
) PARTITION BY RANGE ("block_time");
--> statement-breakpoint

-- Indexes declared on the partitioned parent are auto-propagated to all
-- child partitions (pg11+ feature: USING INDEX ... attaches automatically).
CREATE INDEX "tx_agent_time_idx" ON "agent_transactions" USING btree ("agent_id", "block_time");
--> statement-breakpoint
CREATE INDEX "tx_signature_idx" ON "agent_transactions" USING btree ("signature");
--> statement-breakpoint
CREATE INDEX "tx_instruction_idx" ON "agent_transactions" USING btree ("instruction_name");
--> statement-breakpoint

-- ─── Part 2: Initial monthly partitions ───────────────────────────────────
-- Cover April 2026 (current) through September 2026 (5 months ahead).
-- Future months should be added by a maintenance cron job (post-MVP) or
-- expanded manually before each window closes.

CREATE TABLE "agent_transactions_2026_04" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "agent_transactions_2026_05" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "agent_transactions_2026_06" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "agent_transactions_2026_07" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "agent_transactions_2026_08" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');
--> statement-breakpoint
CREATE TABLE "agent_transactions_2026_09" PARTITION OF "agent_transactions"
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');
--> statement-breakpoint

-- ─── Part 3: Row-Level Security ───────────────────────────────────────────
-- We don't use Supabase Auth (Privy is the auth layer), so we cannot rely
-- on auth.uid(). Instead, the API layer sets a session variable per request:
--   SET LOCAL app.user_id = '<uuid>';
-- and policies match against that.
--
-- The ingestion worker and cron jobs run on a separate Postgres role with
-- the BYPASSRLS attribute (or service_role on Supabase), so they're not
-- subject to these policies.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_transactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reasoning_logs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Helper: stable function that returns the current request's user_id
-- (or NULL if unset). Marked STABLE so the planner can cache it per query.
CREATE OR REPLACE FUNCTION "current_user_id"() RETURNS uuid AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- ─── users: only see your own row ─────────────────────────────────────────
CREATE POLICY "users_self_access" ON "users"
    FOR ALL
    USING ("id" = current_user_id())
    WITH CHECK ("id" = current_user_id());
--> statement-breakpoint

-- ─── agents: only your own agents ─────────────────────────────────────────
CREATE POLICY "agents_owner_access" ON "agents"
    FOR ALL
    USING ("user_id" = current_user_id())
    WITH CHECK ("user_id" = current_user_id());
--> statement-breakpoint

-- ─── agent_transactions: only tx for agents you own ───────────────────────
CREATE POLICY "tx_owner_access" ON "agent_transactions"
    FOR ALL
    USING (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    )
    WITH CHECK (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    );
--> statement-breakpoint

-- ─── reasoning_logs: same isolation ───────────────────────────────────────
CREATE POLICY "reason_owner_access" ON "reasoning_logs"
    FOR ALL
    USING (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    )
    WITH CHECK (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    );
--> statement-breakpoint

-- ─── alerts: same isolation ───────────────────────────────────────────────
CREATE POLICY "alerts_owner_access" ON "alerts"
    FOR ALL
    USING (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    )
    WITH CHECK (
        "agent_id" IN (SELECT "id" FROM "agents" WHERE "user_id" = current_user_id())
    );
