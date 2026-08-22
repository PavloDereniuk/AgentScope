-- ============================================================================
-- 0019 — service_heartbeats (post-MVP roadmap E.13, self-monitoring)
--
-- One row per long-running service. The ingestion worker upserts
-- `service = 'ingestion'` every 30s with its liveness signals; the API reads
-- that row to answer `GET /health/ingestion`, and the keep-alive workflow
-- turns a stale row into a Telegram message.
--
-- Why a table and not a derived query: a quiet fleet and a dead worker look
-- identical in `agent_transactions`. On 2026-07-30 ingestion crash-looped on
-- an INSERT with an unknown enum value and stayed dead for twelve days while
-- the API's `/health` kept returning 200 — the two processes fail
-- independently and only one of them was being watched.
--
-- Not user data: no `user_id`, never served per-tenant. RLS is enabled with
-- NO policy, which denies all access to ordinary roles; api and ingestion both
-- connect as BYPASSRLS service roles and are unaffected. Enabling RLS also
-- keeps `check-schema-drift` (E.12) green, which fails on any table with RLS
-- left off.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "service_heartbeats" (
	"service" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint

ALTER TABLE "service_heartbeats" ENABLE ROW LEVEL SECURITY;
