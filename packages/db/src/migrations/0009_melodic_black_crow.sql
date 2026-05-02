ALTER TYPE "public"."delivery_status" ADD VALUE 'skipped';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "alerts_paused_until" timestamp with time zone;