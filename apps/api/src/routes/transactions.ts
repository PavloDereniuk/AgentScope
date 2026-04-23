/**
 * Single-transaction read route (task 3.11).
 *
 * Unlike the agent-scoped transactions list (3.10), this endpoint is
 * keyed by the on-chain signature alone. Clients paste a signature
 * from an explorer, a log line, or a webhook payload and get back the
 * parsed row plus its reasoning trace.
 *
 * Ownership is enforced inside the SELECT via an INNER JOIN against
 * `agents` on `user_id = :userId`. A signature that either doesn't
 * exist or belongs to another user's agent returns 404 — same
 * no-existence-oracle policy as the other :id routes.
 *
 * Note on partitioning: `agent_transactions` is RANGE-partitioned by
 * `block_time`, so lookups by `signature` alone do not benefit from
 * partition pruning. The `tx_signature_idx` index (declared on the
 * partitioned parent) is propagated to every child partition, so the
 * planner still does a fast index lookup — just across all partitions
 * in parallel. Acceptable for MVP write volumes.
 */

import { type Database, agentTransactions, agents, reasoningLogs } from '@agentscope/db';
import { SOLANA_SIGNATURE_RE } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

// Use the canonical {32,88} base58 regex from @agentscope/shared so the
// read-path accept-set matches the write-path (OTLP persister) — without
// the shared import, fixtures with leading-zero bytes that encode to
// 32–63 chars would be persisted but 422 on lookup.
const signatureParamSchema = z.object({
  signature: z.string().regex(SOLANA_SIGNATURE_RE, 'must be a valid solana signature'),
});

export function createTransactionsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get(
    '/:signature',
    zValidator('param', signatureParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid transaction signature' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { signature } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);

      // Join enforces ownership: only rows whose agent belongs to
      // the authenticated user survive the WHERE clause, so we don't
      // need a second "does this user own it?" query.
      const [joined] = await db
        .select({ transaction: agentTransactions })
        .from(agentTransactions)
        .innerJoin(agents, eq(agentTransactions.agentId, agents.id))
        .where(and(eq(agentTransactions.signature, signature), eq(agents.userId, user.id)))
        .limit(1);

      if (!joined) {
        throw new HTTPException(404, { message: 'transaction not found' });
      }

      // Full span tree (4.7): find all trace IDs that have at least one
      // span correlated to this signature, then return every span in
      // those traces. This gives the dashboard the complete reasoning
      // context — not just the span that triggered the transaction.
      // Limits prevent a DoS via unbounded IN (...) clauses.
      const correlated = await db
        .selectDistinct({ traceId: reasoningLogs.traceId })
        .from(reasoningLogs)
        .where(eq(reasoningLogs.txSignature, signature))
        .limit(10);

      const traceIds = correlated.map((r) => r.traceId);
      const logs =
        traceIds.length > 0
          ? await db
              .select()
              .from(reasoningLogs)
              .where(inArray(reasoningLogs.traceId, traceIds))
              .orderBy(asc(reasoningLogs.startTime))
              .limit(500)
          : [];

      return c.json({ transaction: joined.transaction, reasoningLogs: logs });
    },
  );

  return router;
}
