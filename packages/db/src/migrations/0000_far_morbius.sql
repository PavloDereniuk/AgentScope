CREATE TYPE "public"."agent_framework" AS ENUM('elizaos', 'agent-kit', 'custom');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('live', 'stale', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_type" AS ENUM('trader', 'yield', 'nft', 'other');--> statement-breakpoint
CREATE TYPE "public"."alert_rule_name" AS ENUM('slippage_spike', 'gas_spike', 'drawdown', 'error_rate', 'stale_agent');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."delivery_channel" AS ENUM('telegram', 'discord', 'slack');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_transactions" (
	"id" bigserial NOT NULL,
	"agent_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"program_id" text NOT NULL,
	"instruction_name" text,
	"parsed_args" jsonb,
	"sol_delta" numeric(20, 9) DEFAULT '0' NOT NULL,
	"token_deltas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fee_lamports" bigint DEFAULT 0 NOT NULL,
	"success" boolean NOT NULL,
	"raw_logs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "agent_transactions_id_block_time_pk" PRIMARY KEY("id","block_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"name" text NOT NULL,
	"framework" "agent_framework" NOT NULL,
	"agent_type" "agent_type" NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"webhook_url" text,
	"alert_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingest_token" text NOT NULL,
	"status" "agent_status" DEFAULT 'stale' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"rule_name" "alert_rule_name" NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_channel" "delivery_channel",
	"delivery_status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reasoning_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"span_name" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tx_signature" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_did" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_transactions" ADD CONSTRAINT "agent_transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reasoning_logs" ADD CONSTRAINT "reasoning_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_agent_time_idx" ON "agent_transactions" USING btree ("agent_id","block_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_signature_idx" ON "agent_transactions" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tx_instruction_idx" ON "agent_transactions" USING btree ("instruction_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_user_wallet_unique" ON "agents" USING btree ("user_id","wallet_pubkey");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_user_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_wallet_idx" ON "agents" USING btree ("wallet_pubkey");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_ingest_token_unique" ON "agents" USING btree ("ingest_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_agent_time_idx" ON "alerts" USING btree ("agent_id","triggered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_rule_idx" ON "alerts" USING btree ("rule_name","triggered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_dedupe_idx" ON "alerts" USING btree ("agent_id","rule_name","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reason_agent_time_idx" ON "reasoning_logs" USING btree ("agent_id","start_time");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reason_trace_idx" ON "reasoning_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reason_tx_signature_idx" ON "reasoning_logs" USING btree ("tx_signature");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reason_span_unique" ON "reasoning_logs" USING btree ("trace_id","span_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_privy_did_unique" ON "users" USING btree ("privy_did");