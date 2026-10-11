-- ============================================================================
-- 0021 — agents.webhook_secret (post-MVP roadmap B.3, webhook HMAC signing)
--
-- Every webhook delivery is signed with HMAC-SHA256 under a per-agent secret
-- so the receiver can reject spoofed alert fires. The secret has to be stored
-- in plaintext — HMAC needs the key itself, a hash would be useless.
--
-- NOT NULL with a volatile DEFAULT: Postgres evaluates the default once per
-- existing row on ADD COLUMN, so every agent gets its own secret in the same
-- statement and signing is on for everyone from the first deploy. The value is
-- built from two gen_random_uuid() calls (core since PG13, CSPRNG-backed) to
-- avoid depending on pgcrypto: 64 hex chars, 244 random bits. Same
-- `whsec_` + 64 hex shape the api generates on create / regenerate.
-- ============================================================================

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "webhook_secret" text DEFAULT ('whsec_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) NOT NULL;
