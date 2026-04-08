/**
 * Agents CRUD routes (tasks 3.5 → 3.9).
 *
 * 3.5 — POST   /api/agents           create a new agent
 * 3.6 — GET    /api/agents           list agents for the authenticated user
 * 3.7 — GET    /api/agents/:id       single agent + recent_tx_count + last_alert
 * 3.8 — PATCH  /api/agents/:id       partial update (name/tags/webhookUrl/alertRules)
 * 3.9 — DELETE /api/agents/:id       cascade delete via FK
 *
 * Every route expects `c.var.userId` (a Privy DID) populated by
 * `requireAuth`, and looks up the real `users.id` via `ensureUser`
 * before touching owner-scoped tables. The `user_id` on every inserted
 * row is taken from the token, never from the request body.
 */

import { randomBytes } from 'node:crypto';
import { type Database, agentTransactions, agents, alerts } from '@agentscope/db';
import { createAgentInputSchema, updateAgentInputSchema } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

/**
 * Opaque token issued to an agent's OTel exporter. 192 bits of entropy
 * encoded as base64url — URL-safe, fits into an `Authorization` header
 * without escaping.
 */
function generateIngestToken(): string {
  return `tok_${randomBytes(24).toString('base64url')}`;
}

/**
 * Rolling window used by `recent_tx_count` on agent detail. 24h is the
 * standard dashboard default — consistent with what Datadog/Grafana use
 * for "recent activity" cards, and short enough to be meaningful for a
 * bot that's stuck or idle.
 */
const RECENT_TX_WINDOW_MS = 24 * 60 * 60 * 1000;

const agentIdParamSchema = z.object({ id: z.string().uuid() });

export function createAgentsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.post(
    '/',
    zValidator('json', createAgentInputSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const body = c.req.valid('json');

      const user = await ensureUser(db, privyDid);

      const [agent] = await db
        .insert(agents)
        .values({
          userId: user.id,
          walletPubkey: body.walletPubkey,
          name: body.name,
          framework: body.framework,
          agentType: body.agentType,
          tags: body.tags ? [...body.tags] : [],
          webhookUrl: body.webhookUrl ?? null,
          alertRules: body.alertRules ?? {},
          ingestToken: generateIngestToken(),
        })
        .returning();

      if (!agent) {
        throw new HTTPException(500, { message: 'agent insert returned no row' });
      }
      return c.json({ agent }, 201);
    },
  );

  // 3.6 — List all agents owned by the authenticated user, newest first.
  router.get('/', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);

    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.userId, user.id))
      .orderBy(desc(agents.createdAt));

    return c.json({ agents: rows });
  });

  // 3.7 — Single agent + recent_tx_count (24h window) + last_alert.
  // Uses an ownership-scoped WHERE so an unauthorized id looks the same
  // as a non-existent one (both → 404, no existence oracle).
  router.get(
    '/:id',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!agent) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      const since = new Date(Date.now() - RECENT_TX_WINDOW_MS).toISOString();
      const [txCountRow] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(agentTransactions)
        .where(
          and(eq(agentTransactions.agentId, agentId), gte(agentTransactions.blockTime, since)),
        );
      const recentTxCount = txCountRow?.count ?? 0;

      const [lastAlert] = await db
        .select()
        .from(alerts)
        .where(eq(alerts.agentId, agentId))
        .orderBy(desc(alerts.triggeredAt))
        .limit(1);

      return c.json({
        agent,
        recentTxCount,
        lastAlert: lastAlert ?? null,
      });
    },
  );

  // 3.8 — Partial update. Only name/tags/webhookUrl/alertRules are
  // mutable; framework, walletPubkey, ingestToken and lifecycle fields
  // are intentionally omitted from the input schema, so zod strips any
  // such keys before the UPDATE ever runs. An empty body is accepted
  // and returns the current row unchanged (idempotent / no-op).
  router.patch(
    '/:id',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    zValidator('json', updateAgentInputSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');
      const body = c.req.valid('json');

      const user = await ensureUser(db, privyDid);

      // Build a SET clause only from keys that were actually present
      // in the request. Unset keys are left untouched — this is what
      // makes PATCH genuinely partial.
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.tags !== undefined) patch.tags = [...body.tags];
      if (body.webhookUrl !== undefined) patch.webhookUrl = body.webhookUrl;
      if (body.alertRules !== undefined) patch.alertRules = body.alertRules;

      // Empty body → no-op. Fetch and return current state so clients
      // get a consistent `{agent}` response regardless of payload.
      if (Object.keys(patch).length === 0) {
        const [current] = await db
          .select()
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
          .limit(1);
        if (!current) {
          throw new HTTPException(404, { message: 'agent not found' });
        }
        return c.json({ agent: current });
      }

      const [updated] = await db
        .update(agents)
        .set(patch)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .returning();
      if (!updated) {
        throw new HTTPException(404, { message: 'agent not found' });
      }
      return c.json({ agent: updated });
    },
  );

  return router;
}
