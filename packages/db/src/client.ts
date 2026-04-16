/**
 * Postgres connection factory. Caller is responsible for providing
 * the connection string (read from env at the application boundary,
 * never inside this package). This keeps `@agentscope/db` framework-
 * agnostic and friendly to test harnesses with ephemeral DBs.
 */

import { sql } from 'drizzle-orm';
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

/**
 * Bind the current request's user_id to the database session via the
 * `app.user_id` setting. RLS policies in migration 0001 read this value
 * through the `current_user_id()` SQL function.
 *
 * Must be called inside a transaction (drizzle's `db.transaction`) so
 * `SET LOCAL` is scoped to the current connection and released on commit
 * — otherwise the binding would leak across pooled connections.
 *
 * @param tx     Drizzle transaction (NOT the top-level db client).
 * @param userId UUID string of the authenticated user, or null to clear.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setRequestUserId(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  userId: string | null,
): Promise<void> {
  if (userId === null) {
    await tx.execute(sql`SET LOCAL app.user_id = ''`);
    return;
  }
  if (!UUID_RE.test(userId)) {
    throw new Error(`setRequestUserId: invalid UUID format: "${userId}"`);
  }
  await tx.execute(sql`SET LOCAL app.user_id = ${userId}`);
}

/**
 * Convenience: run `fn` inside a transaction with the user_id pre-bound.
 * The transaction commits on success, rolls back on throw, and releases
 * the session variable either way.
 *
 * Usage from API routes:
 * ```ts
 * const result = await withRequestUser(db, userId, async (tx) => {
 *   return tx.select().from(agents);
 * });
 * ```
 */
export async function withRequestUser<T>(
  database: Database,
  userId: string,
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await setRequestUserId(tx, userId);
    return fn(tx);
  });
}
