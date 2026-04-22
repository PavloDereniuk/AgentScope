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
   * Telegram credentials used by POST /api/agents/:id/test-alert (task 13.7).
   * Both optional — the endpoint returns `{ok: false, error: '...'}` if either
   * is missing, so the API stays bootable in environments that don't need
   * alert delivery (tests, local dev without Telegram).
   */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_DEFAULT_CHAT_ID: z.string().optional(),
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
