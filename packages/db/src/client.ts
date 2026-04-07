/**
 * Postgres connection factory. Caller is responsible for providing
 * the connection string (read from env at the application boundary,
 * never inside this package). This keeps `@agentscope/db` framework-
 * agnostic and friendly to test harnesses with ephemeral DBs.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export interface DbConfig {
  /** Postgres connection URI (postgres://user:pass@host:port/db). */
  connectionString: string;
  /** Maximum pool size. Default 10 — fits Supabase free tier (60 conn limit). */
  maxConnections?: number | undefined;
  /** Statement timeout in ms. Default 30s. */
  statementTimeoutMs?: number | undefined;
  /** Set true to require TLS (Supabase always does). Default true. */
  ssl?: boolean | undefined;
}

/**
 * Build a Drizzle client. Pure factory — no module-level state.
 * Disposing: call `await client.$client.end()` to close the pool.
 */
export function createDb(config: DbConfig) {
  const sql = postgres(config.connectionString, {
    max: config.maxConnections ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: config.ssl ?? 'require',
    connection: {
      statement_timeout: config.statementTimeoutMs ?? 30_000,
    },
  });

  return drizzle(sql, { casing: 'snake_case' });
}

export type Database = ReturnType<typeof createDb>;
