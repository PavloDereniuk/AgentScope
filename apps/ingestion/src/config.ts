/**
 * Environment configuration for the ingestion worker.
 * Validated once at startup; throws with a clear message if anything
 * required is missing, so the worker fails fast instead of silently
 * misbehaving in production.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── Partition maintenance (storage hygiene) ────────────────────────────────
  /**
   * How many months ahead the worker pre-creates `agent_transactions`
   * partitions for. The initial migration only seeded through 2026-09, so
   * without this roll-forward every tx after 2026-10 falls into the DEFAULT
   * partition. Default 3 gives a comfortable buffer before any month opens.
   */
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(0).default(3),
  /**
   * Retention window in months for `agent_transactions`. `0` (default)
   * DISABLES TTL drops — dropping a user's tx history is a deliberate
   * product decision, so it stays off until storage pressure is real. Set
   * e.g. `3` to keep the current month plus the previous two and free older
   * partitions, keeping the Supabase free-tier 500 MB cap in check.
   */
  TX_RETENTION_MONTHS: z.coerce.number().int().min(0).default(0),

  SOLANA_NETWORK: z.enum(['devnet', 'mainnet']).default('mainnet'),
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),
  /** HTTP JSON-RPC URL (Helius free tier). Used for getTransaction hydrate calls. */
  SOLANA_RPC_URL: z.string().url('SOLANA_RPC_URL must be a URL'),
  /** Optional WS endpoint override; defaults to SOLANA_RPC_URL with http→ws. */
  SOLANA_WS_URL: z.string().url().optional(),
  // Yellowstone gRPC (LaserStream) — paid on Helius. Optional, unused in MVP.
  YELLOWSTONE_GRPC_URL: z.string().url().optional(),
  YELLOWSTONE_GRPC_TOKEN: z.string().optional(),
  /** URL of the API server for internal event publishing. */
  API_INTERNAL_URL: z.string().url().optional(),
  /** Shared secret for /internal/* endpoints — must match API's INTERNAL_SECRET. */
  INTERNAL_SECRET: z.string().min(32).optional(),

  // ── Alerter (Telegram) ─────────────────────────────────────────────────────
  /** Telegram bot token (BotFather). Required to deliver alerts via Telegram. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  /**
   * Chat where platform-wide admin notifications go (Epic 14 Phase 3
   * task 14.16 — abuse signup-spike alert). Unset in dev/tests → the
   * abuse monitor runs in log-only mode without emitting a Telegram
   * message. Must NOT reuse `TELEGRAM_DEFAULT_CHAT_ID`: the admin chat
   * is for ops pings, not for re-routing user alerts.
   */
  TELEGRAM_ADMIN_CHAT_ID: z.string().min(1).optional(),
  /**
   * @deprecated since Epic 14 Phase 1. Per-agent chat_id now travels on
   * each AlertMessage via `agents.telegram_chat_id`; the sender no longer
   * falls back to this env var (would re-route new users' alerts to the
   * platform owner's chat). Kept optional so existing .env files don't
   * fail validation, but the value is never read. Remove after one
   * release cycle.
   */
  TELEGRAM_DEFAULT_CHAT_ID: z.string().min(1).optional(),

  // ── Demo agent seeder (C.0b) ───────────────────────────────────────────────
  /**
   * UUID of the demo agent to keep populated with synthetic transactions and
   * reasoning spans. When set, `startDemoSeeder` runs every 4 hours inside
   * the ingestion worker — no extra infrastructure required.
   * Must match PUBLIC_DEMO_AGENT_ID on the API service.
   */
  DEMO_AGENT_ID: z.string().uuid().optional(),
  /** Set to "true" once to wipe and re-seed demo data. Remove after first deploy. */
  DEMO_SEED_RESET: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: z.ZodIssue) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
