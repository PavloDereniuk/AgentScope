/**
 * Environment configuration for the API server.
 * Validated once at startup via zod; throws with a clear message if
 * anything required is missing, so the process fails fast instead of
 * silently misbehaving in production.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  PRIVY_APP_ID: z.string().min(1, 'PRIVY_APP_ID is required'),
  PRIVY_APP_SECRET: z.string().min(1, 'PRIVY_APP_SECRET is required'),
  /** Shared secret for cross-service /internal/* endpoints. */
  INTERNAL_SECRET: z.string().min(32, 'INTERNAL_SECRET must be at least 32 chars'),
  /**
   * Telegram bot token used by POST /api/agents/:id/test-alert (task 13.7).
   * Optional — /test-alert returns 503 when missing, so the API stays
   * bootable in environments that don't need alert delivery (tests, local
   * dev without Telegram). Per-agent chat_id rides on each AlertMessage
   * (Epic 14 multi-tenant safety) — no deployer-wide chat_id fallback.
   */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  /**
   * Telegram bot username (no leading @). Used to build the t.me deep link
   * returned by POST /api/telegram/init (task 14.11). Optional — when
   * unset, /init returns 503 and the dashboard falls back to the manual
   * chat_id input on Settings.
   */
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  /**
   * @deprecated since Epic 14 Phase 1. Per-agent chat_id now travels on
   * each AlertMessage via `agents.telegram_chat_id`; the sender no longer
   * falls back to this env var (would re-route new users' alerts to the
   * platform owner's chat). Kept optional so existing .env files don't
   * fail validation. Remove after one release cycle.
   */
  TELEGRAM_DEFAULT_CHAT_ID: z.string().optional(),
  /**
   * Comma-separated list of browser origins allowed to call the API
   * cross-origin. In production, the dashboard runs on Vercel under a
   * different host than the API on Railway, so the browser requires a
   * matching `Access-Control-Allow-Origin` on every response.
   *
   * Leave unset in local dev — the Vite dev-proxy in `apps/dashboard`
   * keeps requests same-origin, so no CORS headers are needed. Empty
   * string is treated the same as unset; parsed values are trimmed.
   *
   * Example: `https://app.agentscopehq.dev,https://agentscopehq.dev`.
   */
  DASHBOARD_ORIGINS: z.string().optional().default(''),
  /**
   * Hard cap on agents one user can own (Epic 14 Phase 3 — abuse
   * hardening). Stops a single Privy account from sink-holing the
   * Helius free-tier budget and Supabase row budget during the public
   * beta. Default 2 is tight but honest — real users can delete an
   * agent to register another; in-repo demo walkthroughs never need
   * more than 2 concurrent agents.
   */
  MAX_AGENTS_PER_USER: z.coerce.number().int().positive().default(2),
  /**
   * Comma-separated Privy DIDs that bypass `MAX_AGENTS_PER_USER`
   * entirely. Intended for the platform owner / internal load-test
   * accounts that need to spin up many concurrent agents without
   * loosening the cap for the general public.
   *
   * Empty / unset → no whitelist; the cap applies to everyone.
   * Other abuse defenses (per-IP throttle, signup-spike monitor,
   * rate limiter on POST /api/agents) still apply to whitelisted
   * users — only the count cap is skipped.
   */
  OWNER_PRIVY_DIDS: z.string().optional().default(''),
});

export type Config = z.infer<typeof envSchema> & { OWNER_PRIVY_DID_SET: Set<string> };

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i: z.ZodIssue) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  // Pre-compute the owner DID set so each agent-create request does a
  // single Set#has lookup instead of re-splitting the string per call.
  const ownerDids = new Set(
    parsed.data.OWNER_PRIVY_DIDS.split(',')
      .map((d) => d.trim())
      .filter((d) => d.length > 0),
  );
  return { ...parsed.data, OWNER_PRIVY_DID_SET: ownerDids };
}
