-- ============================================================================
-- 0023 — agents.previous_ingest_token (post-MVP roadmap B.8, token rotation)
--
-- Rotating an agent's ingest token moves the current value here and stamps
-- an expiry one hour out. Until then the ingest auth lookup accepts either
-- token, so a running agent keeps emitting while its owner redeploys it with
-- the new one. Only one previous token is kept: rotating again inside the
-- window drops the older one immediately. A rotation with no grace window
-- (compromised token) leaves both columns NULL.
--
-- Expired values are never swept — the lookup compares the expiry with now(),
-- and the next rotation overwrites them.
--
-- Nullable columns without a default: ADD COLUMN is metadata-only. The
-- partial index keeps the fallback lookup an index probe while costing
-- nothing for the (almost all) agents that never rotate. Not unique: the
-- values are 192-bit random tokens, and a collision with a live
-- ingest_token is already impossible in practice.
-- ============================================================================

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "previous_ingest_token" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "previous_ingest_token_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_previous_ingest_token_idx" ON "agents" ("previous_ingest_token") WHERE "previous_ingest_token" IS NOT NULL;
