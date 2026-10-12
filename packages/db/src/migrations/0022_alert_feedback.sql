-- ============================================================================
-- 0022 — alerts.feedback (post-MVP roadmap C.10, alert feedback)
--
-- The owner labels each alert in the feed as `useful` or `noise`. The labels
-- surface as a per-rule noise rate in Settings and are the ground truth the
-- D.1 threshold tuner will calibrate against, instead of raw fire counts.
--
-- text + CHECK instead of a pg enum, same as upgrade_requests.plan (0020):
-- an enum would need ALTER TYPE outside a transaction to grow, and the two
-- values are owned by the api's zod schema anyway. NULL = not labelled;
-- clearing a label sets both columns back to NULL.
--
-- Nullable columns without a default: ADD COLUMN is metadata-only, no table
-- rewrite on the (large) alerts table. RLS is unchanged — the existing
-- alerts_owner_access policy already scopes the rows.
-- ============================================================================

ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "feedback" text;
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "feedback_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "alerts" ADD CONSTRAINT "alerts_feedback_check" CHECK ("feedback" IN ('useful', 'noise'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
