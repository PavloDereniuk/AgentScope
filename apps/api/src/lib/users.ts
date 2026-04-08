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
 * Look up the `users` row for a Privy DID, creating it on first sight.
 * Uses INSERT ... ON CONFLICT DO NOTHING then falls back to SELECT — the
 * upsert is resilient to concurrent first-login races between requests.
 */
export async function ensureUser(db: Database, privyDid: string): Promise<EnsuredUser> {
  const inserted = await db
    .insert(users)
    .values({ privyDid })
    .onConflictDoNothing({ target: users.privyDid })
    .returning({ id: users.id, privyDid: users.privyDid });

  if (inserted[0]) {
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
  return existing[0];
}
