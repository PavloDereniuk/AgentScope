/**
 * Alerts read route (task 3.12).
 *
 * Global feed of alerts across every agent the authenticated user
 * owns, newest first. Filters: agentId (narrow to a single agent),
 * severity (info/warning/critical), from/to (triggered_at window).
 *
 * Ownership is enforced via an INNER JOIN against `agents` on
 * `user_id = :userId`, so foreign rows are dropped before any filter
 * applies. There is no cursor pagination in MVP — we cap at 100 rows
 * ordered by triggered_at DESC. If a user ever has more than 100
 * active alerts, post-MVP can add the same keyset cursor shape we use
 * for the transactions list.
 */

import { type Database, agents, alerts } from '@agentscope/db';
import { ALERT_SEVERITIES } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { type SQL, and, desc, eq, gte, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

/** Maximum rows returned by a single /api/alerts call (MVP cap). */
const MAX_ALERTS_PAGE = 100;

const alertsListQuerySchema = z
  .object({
    agentId: z.string().uuid().optional(),
    severity: z.enum(ALERT_SEVERITIES).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  // Lexicographic string compare is only correct when both ISO strings share
  // the exact same canonical form. z.datetime({offset:true}) accepts both Z
  // and ±HH:MM suffixes, so `2026-04-18T00:00:00+02:00` vs `...:00Z` would
  // compare wrong as text. Compare epoch milliseconds instead.
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: 'from must be <= to',
    path: ['from'],
  });

export function createAlertsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get(
    '/',
    zValidator('query', alertsListQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { agentId, severity, from, to } = c.req.valid('query');

      const user = await ensureUser(db, privyDid);

      const where: SQL[] = [eq(agents.userId, user.id)];
      if (agentId) where.push(eq(alerts.agentId, agentId));
      if (severity) where.push(eq(alerts.severity, severity));
      if (from) where.push(gte(alerts.triggeredAt, from));
      if (to) where.push(lte(alerts.triggeredAt, to));

      const rows = await db
        .select({ alert: alerts })
        .from(alerts)
        .innerJoin(agents, eq(alerts.agentId, agents.id))
        .where(and(...where))
        .orderBy(desc(alerts.triggeredAt))
        .limit(MAX_ALERTS_PAGE);

      return c.json({ alerts: rows.map((r) => r.alert) });
    },
  );

  return router;
}
