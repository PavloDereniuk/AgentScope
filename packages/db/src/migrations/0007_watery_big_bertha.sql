-- ============================================================================
-- 0007 — telegram_bindings (one-time codes for /start <code> bot deep-link)
--
-- Epic 14 Phase 2: replace manual chat_id paste with a one-click linking
-- flow. Dashboard creates a binding, user opens t.me/<bot>?start=<code>,
-- bot resolves the code and writes chat_id back. Dashboard polls
-- /api/telegram/status until linked.
--
-- TTL is enforced at lookup ("created_at > now() - interval '10 min'" for
-- unlinked rows) plus a periodic janitor in the ingestion worker —
-- Supabase free has no pg_cron, so a real TTL trigger is unavailable.
--
-- RLS: users only see their own bindings. The ingestion worker connects
-- as a BYPASSRLS role (Supabase service_role) so the bot can resolve
-- codes for any user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "telegram_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"binding_code" text NOT NULL,
	"chat_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "telegram_bindings" ADD CONSTRAINT "telegram_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_bindings_code_unique" ON "telegram_bindings" USING btree ("binding_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_bindings_user_idx" ON "telegram_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_bindings_created_at_idx" ON "telegram_bindings" USING btree ("created_at");--> statement-breakpoint

-- ─── Row-Level Security ───────────────────────────────────────────────────
-- Same pattern as 0001: API sets `app.user_id` per request; only matching
-- user_id rows are visible. Ingestion (BYPASSRLS / service_role) reads all.

ALTER TABLE "telegram_bindings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "telegram_bindings_owner_access" ON "telegram_bindings"
    FOR ALL
    USING ("user_id" = current_user_id())
    WITH CHECK ("user_id" = current_user_id());
