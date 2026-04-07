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

  SOLANA_NETWORK: z.enum(['devnet', 'mainnet']).default('devnet'),
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),
  YELLOWSTONE_GRPC_URL: z.string().url('YELLOWSTONE_GRPC_URL must be a URL'),
  YELLOWSTONE_GRPC_TOKEN: z.string().optional(),
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
