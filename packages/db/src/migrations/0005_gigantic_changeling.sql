-- ============================================================================
-- 0005 — agents.telegram_chat_id for per-agent alert delivery
--
-- Epic 14 (multi-tenant readiness): alerts must route to the owning user's
-- Telegram chat, not a single deployer-wide TELEGRAM_DEFAULT_CHAT_ID. Store
-- per-agent chat_id here; a null value falls back to the env default (kept
-- for demo agents so the existing flow isn't broken).
--
-- Drizzle-kit's generator also emitted three self-healing statements that
-- are no-ops against the live DB (the referenced indexes already exist from
-- migrations 0003/0004 and are guarded by `IF NOT EXISTS`/`IF EXISTS`). They
-- were removed here to keep the migration chain readable.
-- ============================================================================

ALTER TABLE "agents" ADD COLUMN "telegram_chat_id" text;
