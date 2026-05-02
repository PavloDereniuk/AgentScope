-- IF NOT EXISTS makes both statements idempotent so a partial-retry after a
-- network blip during migrate does not fail with duplicate_object /
-- duplicate_column. Sibling 0008 follows the same pattern on its enum adds.
ALTER TYPE "public"."delivery_status" ADD VALUE IF NOT EXISTS 'skipped';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "alerts_paused_until" timestamp with time zone;