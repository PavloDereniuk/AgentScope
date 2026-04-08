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
import { type Database, agents } from '@agentscope/db';
import { createAgentInputSchema } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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

  return router;
}
