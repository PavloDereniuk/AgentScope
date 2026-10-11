/**
 * Paid-plan request routes (post-MVP roadmap H.1).
 *
 * GET /api/upgrade-request — the caller's request, or `null`
 * PUT /api/upgrade-request — create or replace the caller's request
 *
 * Shown to users who hit the free agent cap. No billing: a row is a demand
 * signal the owner reads before pricing is final. One request per user —
 * PUT upserts on `user_id` and clears `notified_at`, which re-queues the
 * admin Telegram ping in the ingestion worker (see
 * apps/ingestion/src/upgrade-request-notifier.ts). The api never talks to
 * Telegram itself.
 */

import { type Database, upgradeRequests } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

export const UPGRADE_PLANS = ['pro', 'team'] as const;

const upgradeRequestSchema = z.object({
  plan: z.enum(UPGRADE_PLANS),
  /** Email or Telegram handle — free text, we only need a way to reply. */
  contact: z.string().trim().min(3).max(200),
  agentCount: z.number().int().min(1).max(10_000),
  useCase: z.string().trim().min(1).max(1000),
});

export type UpgradeRequestInput = z.infer<typeof upgradeRequestSchema>;

function toResponse(row: typeof upgradeRequests.$inferSelect) {
  return {
    plan: row.plan,
    contact: row.contact,
    agentCount: row.agentCount,
    useCase: row.useCase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createUpgradeRequestRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get('/', async (c) => {
    const user = await ensureUser(db, c.get('userId'));
    const [row] = await db
      .select()
      .from(upgradeRequests)
      .where(eq(upgradeRequests.userId, user.id))
      .limit(1);
    return c.json({ request: row ? toResponse(row) : null });
  });

  router.put(
    '/',
    zValidator('json', upgradeRequestSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid upgrade request' });
      }
    }),
    async (c) => {
      const user = await ensureUser(db, c.get('userId'));
      const input = c.req.valid('json');

      const [row] = await db
        .insert(upgradeRequests)
        .values({ userId: user.id, ...input })
        .onConflictDoUpdate({
          target: upgradeRequests.userId,
          set: {
            ...input,
            updatedAt: sql`now()`,
            // Re-queue the admin ping so the owner sees the revised request.
            notifiedAt: null,
          },
        })
        .returning();

      if (!row) throw new HTTPException(500, { message: 'upgrade request not saved' });
      return c.json({ request: toResponse(row) });
    },
  );

  return router;
}
