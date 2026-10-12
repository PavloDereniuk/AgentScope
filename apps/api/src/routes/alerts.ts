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
 *
 * Feedback (C.10): `PATCH /:id/feedback` labels one alert `useful` /
 * `noise` (or clears it with null), and `GET /feedback-stats` rolls the
 * labels up per rule for one agent — the noise rate shown in Settings.
 */

import { type Database, agents, alerts } from '@agentscope/db';
import { ALERT_FEEDBACK_VALUES, ALERT_SEVERITIES } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { type SQL, and, desc, eq, gte, lte, sql } from 'drizzle-orm';
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

/** Look-back window for the per-rule noise rate in Settings. */
export const FEEDBACK_STATS_WINDOW_DAYS = 30;

const alertIdParamSchema = z.object({ id: z.string().uuid() });

const alertFeedbackBodySchema = z
  .object({ feedback: z.enum(ALERT_FEEDBACK_VALUES).nullable() })
  .strict();

const feedbackStatsQuerySchema = z.object({ agentId: z.string().uuid() });

/** Shared zod hook: every validation failure is a 422 with a flat message. */
function unprocessable(result: { success: boolean; error?: z.ZodError }): void {
  if (!result.success && result.error) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new HTTPException(422, { message });
  }
}

export function createAlertsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get('/', zValidator('query', alertsListQuerySchema, unprocessable), async (c) => {
    const privyDid = c.get('userId');
    const { agentId, severity, from, to } = c.req.valid('query');

    const user = await ensureUser(db, privyDid);

    const where: SQL[] = [eq(agents.userId, user.id)];
    if (agentId) where.push(eq(alerts.agentId, agentId));
    if (severity) where.push(eq(alerts.severity, severity));
    if (from) where.push(gte(alerts.triggeredAt, from));
    if (to) where.push(lte(alerts.triggeredAt, to));

    const rows = await db
      .select({ alert: alerts, agentName: agents.name })
      .from(alerts)
      .innerJoin(agents, eq(alerts.agentId, agents.id))
      .where(and(...where))
      .orderBy(desc(alerts.triggeredAt))
      .limit(MAX_ALERTS_PAGE);

    return c.json({
      alerts: rows.map((r) => ({ ...r.alert, agentName: r.agentName })),
    });
  });

  router.patch(
    '/:id/feedback',
    zValidator('param', alertIdParamSchema, unprocessable),
    zValidator('json', alertFeedbackBodySchema, unprocessable),
    async (c) => {
      const privyDid = c.get('userId');
      const { id } = c.req.valid('param');
      const { feedback } = c.req.valid('json');

      const user = await ensureUser(db, privyDid);

      // Ownership lives on agents, not alerts — the subquery keeps a
      // foreign alert id indistinguishable from a missing one (404 both).
      const [row] = await db
        .update(alerts)
        .set({ feedback, feedbackAt: feedback === null ? null : new Date().toISOString() })
        .where(
          and(
            eq(alerts.id, id),
            sql`${alerts.agentId} in (select ${agents.id} from ${agents} where ${agents.userId} = ${user.id})`,
          ),
        )
        .returning({ id: alerts.id, feedback: alerts.feedback, feedbackAt: alerts.feedbackAt });

      if (!row) throw new HTTPException(404, { message: 'alert not found' });
      return c.json({ alert: row });
    },
  );

  router.get(
    '/feedback-stats',
    zValidator('query', feedbackStatsQuerySchema, unprocessable),
    async (c) => {
      const privyDid = c.get('userId');
      const { agentId } = c.req.valid('query');

      const user = await ensureUser(db, privyDid);

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!agent) throw new HTTPException(404, { message: 'agent not found' });

      const since = new Date(
        Date.now() - FEEDBACK_STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();

      const rules = await db
        .select({
          ruleName: alerts.ruleName,
          total: sql<number>`cast(count(*) as int)`,
          useful: sql<number>`cast(count(*) filter (where ${alerts.feedback} = 'useful') as int)`,
          noise: sql<number>`cast(count(*) filter (where ${alerts.feedback} = 'noise') as int)`,
        })
        .from(alerts)
        .where(and(eq(alerts.agentId, agentId), gte(alerts.triggeredAt, since)))
        .groupBy(alerts.ruleName)
        .orderBy(alerts.ruleName);

      return c.json({ windowDays: FEEDBACK_STATS_WINDOW_DAYS, rules });
    },
  );

  return router;
}
