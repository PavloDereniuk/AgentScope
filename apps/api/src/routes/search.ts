/**
 * Cross-entity search (task 13.11).
 *
 * GET /api/search?q=foo
 *
 * Returns up to 20 hits of `{type, id, label, hint}` spanning agents,
 * transactions, and reasoning traces the caller owns. Feeds the ⌘K
 * command palette (13.12) on the dashboard — the shape is deliberately
 * uniform so the client renders every row through one code path.
 *
 * Matching rules:
 * - agent:  ILIKE against name OR wallet_pubkey (contains, case-insensitive)
 * - tx:     ILIKE against signature (prefix — user usually pastes the head)
 * - trace:  ILIKE against trace_id (prefix — OTel ids are 32 hex chars)
 *
 * Ownership is enforced server-side via INNER JOIN agents ON user_id.
 * We never expose whether a given signature/trace exists outside the
 * caller's tenancy: a miss and a foreign hit both return the same empty
 * slice for that type.
 */

import { type Database, agentTransactions, agents, reasoningLogs } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const MAX_RESULTS = 20;
/** Per-type cap BEFORE the final merge — keeps a very common agent name
 *  from drowning tx/trace hits while still producing up to MAX_RESULTS total. */
const PER_TYPE_LIMIT = 10;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(128),
});

/**
 * Escape LIKE metacharacters so `%` and `_` typed by the user behave as
 * literal characters. We pair every ILIKE with `ESCAPE '\\'` so the
 * backslash unambiguously quotes the next char.
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface SearchHit {
  type: 'agent' | 'tx' | 'trace';
  id: string;
  label: string;
  hint: string;
}

export function createSearchRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get(
    '/',
    zValidator('query', searchQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { q } = c.req.valid('query');
      const user = await ensureUser(db, privyDid);

      const escaped = escapeLike(q);
      const contains = `%${escaped}%`;
      const prefix = `${escaped}%`;

      // Three independent queries run in parallel — three shapes that
      // don't compose cleanly in drizzle's union builder, and parallel
      // keeps latency bounded by the slowest of the three instead of
      // their sum.
      const [agentRows, txRows, traceRows] = await Promise.all([
        db
          .select({
            id: agents.id,
            label: agents.name,
            hint: agents.walletPubkey,
          })
          .from(agents)
          .where(
            and(
              eq(agents.userId, user.id),
              or(
                sql`${agents.name} ilike ${contains} escape '\\'`,
                sql`${agents.walletPubkey} ilike ${contains} escape '\\'`,
              ),
            ),
          )
          .limit(PER_TYPE_LIMIT),
        db
          .select({
            signature: agentTransactions.signature,
            blockTime: agentTransactions.blockTime,
            agentName: agents.name,
          })
          .from(agentTransactions)
          .innerJoin(agents, eq(agentTransactions.agentId, agents.id))
          .where(
            and(
              eq(agents.userId, user.id),
              sql`${agentTransactions.signature} ilike ${prefix} escape '\\'`,
            ),
          )
          .orderBy(desc(agentTransactions.blockTime))
          .limit(PER_TYPE_LIMIT),
        db
          .select({
            traceId: reasoningLogs.traceId,
            startTime: sql<string>`min(${reasoningLogs.startTime})`,
            agentName: sql<string>`max(${agents.name})`,
          })
          .from(reasoningLogs)
          .innerJoin(agents, eq(reasoningLogs.agentId, agents.id))
          .where(
            and(
              eq(agents.userId, user.id),
              sql`${reasoningLogs.traceId} ilike ${prefix} escape '\\'`,
            ),
          )
          .groupBy(reasoningLogs.traceId)
          .orderBy(desc(sql`min(${reasoningLogs.startTime})`))
          .limit(PER_TYPE_LIMIT),
      ]);

      const results: SearchHit[] = [];

      // Order: agents first (exact name hits matter most), then tx (most
      // recent), then traces. The palette renders in this order too.
      for (const row of agentRows) {
        results.push({
          type: 'agent',
          id: row.id,
          label: row.label,
          hint: row.hint,
        });
      }
      for (const row of txRows) {
        results.push({
          type: 'tx',
          id: row.signature,
          label: row.signature,
          hint: `${row.agentName} · ${row.blockTime}`,
        });
      }
      for (const row of traceRows) {
        results.push({
          type: 'trace',
          id: row.traceId,
          label: row.traceId,
          hint: `${row.agentName} · ${row.startTime}`,
        });
      }

      return c.json({ q, results: results.slice(0, MAX_RESULTS) });
    },
  );

  return router;
}
