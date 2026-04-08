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
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const signatureParamSchema = z.object({
  signature: z.string().min(64).max(88).regex(BASE58_RE, 'must be base58'),
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

      // Reasoning logs are persisted with the correlated tx_signature
      // by the OTLP receiver (task 4.5). For txs without an attached
      // trace we return an empty array — never null — so the shape is
      // stable for the dashboard timeline.
      const logs = await db
        .select()
        .from(reasoningLogs)
        .where(eq(reasoningLogs.txSignature, signature))
        .orderBy(asc(reasoningLogs.startTime));

      return c.json({ transaction: joined.transaction, reasoningLogs: logs });
    },
  );

  return router;
}
