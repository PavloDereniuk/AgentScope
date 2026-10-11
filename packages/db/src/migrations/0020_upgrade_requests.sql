-- ============================================================================
-- 0020 — upgrade_requests (post-MVP roadmap H.1, monetization signal)
--
-- A user who hits the free agent cap can leave a request for a paid plan
-- (planned: Pro / Team). No billing happens here — the table only collects
-- demand so pricing is decided against real requests, not guesses.
--
-- One row per user (unique user_id): a second submit updates the same row
-- and clears `notified_at`, so the owner sees the revised request instead of
-- a pile of duplicates. The ingestion worker polls rows with
-- `notified_at IS NULL`, pings the admin Telegram chat, then stamps
-- `notified_at` — an outbox, so a Telegram outage delays the ping instead of
-- losing the request, and the api needs no bot credentials.
--
-- User data → RLS with the standard owner policy, same as telegram_bindings.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "upgrade_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"contact" text NOT NULL,
	"agent_count" integer NOT NULL,
	"use_case" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "upgrade_requests_plan_check" CHECK ("plan" IN ('pro', 'team')),
	CONSTRAINT "upgrade_requests_agent_count_check" CHECK ("agent_count" BETWEEN 1 AND 10000)
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "upgrade_requests" ADD CONSTRAINT "upgrade_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "upgrade_requests_user_unique" ON "upgrade_requests" USING btree ("user_id");
--> statement-breakpoint

-- Partial index: the notifier only ever scans the un-notified tail.
CREATE INDEX IF NOT EXISTS "upgrade_requests_pending_notify_idx" ON "upgrade_requests" USING btree ("updated_at") WHERE "notified_at" IS NULL;
--> statement-breakpoint

ALTER TABLE "upgrade_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "upgrade_requests_owner_access" ON "upgrade_requests"
    FOR ALL
    USING ("user_id" = current_user_id())
    WITH CHECK ("user_id" = current_user_id());
