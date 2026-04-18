/**
 * User provisioning helpers.
 *
 * Privy is the authentication source of truth — the middleware gives us
 * a stable DID (`did:privy:...`), but our database still needs a row in
 * `users` to anchor agents, RLS, and joins. The first time an
 * authenticated user hits an API endpoint, we upsert a row keyed by the
 * DID and use its UUID as the `user_id` for downstream inserts.
 *
 * Called from every protected route that writes to owner-scoped tables.
 */

import { type Database, users } from '@agentscope/db';
import { eq } from 'drizzle-orm';

export interface EnsuredUser {
  id: string;
  privyDid: string;
}

/**
 * Per-database cache of resolved Privy DID → users row. The mapping is
 * stable for the lifetime of a user (DIDs are immutable and our schema
 * does not re-issue user.id), so a simple Map with an LRU bound is
 * sufficient. This avoids hitting Postgres on every /api/* request once
 * a user is warm.
 *
 * Keyed by the Database instance (not module-global) so that test suites
 * creating a fresh PGlite per `beforeEach` get a clean cache automatically
 * — otherwise a stale DID → uuid mapping from a prior test would produce
 * FK violations when the next test writes agents against a new database.
 */
const CACHE_MAX = 10_000;
const dbCaches = new WeakMap<Database, Map<string, EnsuredUser>>();

function getCache(db: Database): Map<string, EnsuredUser> {
  let cache = dbCaches.get(db);
  if (!cache) {
    cache = new Map();
    dbCaches.set(db, cache);
  }
  return cache;
}

function cacheGet(db: Database, privyDid: string): EnsuredUser | undefined {
  const cache = getCache(db);
  const hit = cache.get(privyDid);
  if (hit !== undefined) {
    // Refresh LRU order on hit.
    cache.delete(privyDid);
    cache.set(privyDid, hit);
  }
  return hit;
}

function cacheSet(db: Database, user: EnsuredUser): void {
  const cache = getCache(db);
  if (cache.size >= CACHE_MAX) {
    // Evict oldest entry — Map iteration order is insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(user.privyDid, user);
}

/**
 * Look up the `users` row for a Privy DID, creating it on first sight.
 * Uses INSERT ... ON CONFLICT DO NOTHING then falls back to SELECT — the
 * upsert is resilient to concurrent first-login races between requests.
 */
export async function ensureUser(db: Database, privyDid: string): Promise<EnsuredUser> {
  const cached = cacheGet(db, privyDid);
  if (cached) return cached;

  const inserted = await db
    .insert(users)
    .values({ privyDid })
    .onConflictDoNothing({ target: users.privyDid })
    .returning({ id: users.id, privyDid: users.privyDid });

  if (inserted[0]) {
    cacheSet(db, inserted[0]);
    return inserted[0];
  }

  const existing = await db
    .select({ id: users.id, privyDid: users.privyDid })
    .from(users)
    .where(eq(users.privyDid, privyDid))
    .limit(1);

  if (!existing[0]) {
    throw new Error(`user ensure failed: no row found after upsert for ${privyDid}`);
  }
  cacheSet(db, existing[0]);
  return existing[0];
}
