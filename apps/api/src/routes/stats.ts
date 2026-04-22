/**
 * Cross-agent stats routes (task 13.1).
 *
 * 13.1 — GET /api/stats/overview  → aggregate KPIs for the Overview page.
 *
 * Returns a single shape that the dashboard uses to populate its top KPI
 * strip without having to recompute sums client-side from the agents and
 * alerts lists:
 *
 *   {
 *     tx24h:            number   // transactions the user's agents produced in the last 24h
 *     solDelta24h:      string   // SUM(sol_delta) over the same window, numeric preserved as string
 *     successRate24h:   number | null  // successful / total in the window, null if no tx
 *     activeAgents:     number   // agents with status='live'
 *     criticalAlerts:   number   // alerts with severity='critical' triggered in the last 24h
 *   }
 *
 * Every aggregate is scoped to the authenticated user via an INNER JOIN
 * on `agents.user_id`. The 24h window matches the existing convention
 * used by `GET /api/agents/:id` (RECENT_TX_WINDOW_MS in routes/agents.ts).
 *
 * `solDelta24h` is returned as a string because `agent_transactions.sol_delta`
 * is `numeric(20,9)` — lamport precision overflows JS number. Dashboards
 * that only need the integer SOL part can parseFloat; anyone who actually
 * cares about the 9 decimals can use a BigInt/decimal library.
 */

import { type Database, agentTransactions, agents, alerts } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

/** 24h rolling window for overview KPIs. Matches RECENT_TX_WINDOW_MS in agents.ts. */
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createStatsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get('/overview', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);
    const since = new Date(Date.now() - STATS_WINDOW_MS).toISOString();

    // tx aggregates in one query: total count, sum of sol_delta, successful count.
    // Scope via INNER JOIN so foreign rows drop before the aggregation runs.
    const [txRow] = await db
      .select({
        tx24h: sql<number>`cast(count(*) as int)`,
        // coalesce(sum(...), 0) keeps the shape stable when a user has no tx
        solDelta24h: sql<string>`coalesce(sum(${agentTransactions.solDelta}), 0)::text`,
        successCount: sql<number>`cast(count(*) filter (where ${agentTransactions.success}) as int)`,
      })
      .from(agentTransactions)
      .innerJoin(agents, eq(agentTransactions.agentId, agents.id))
      .where(and(eq(agents.userId, user.id), gte(agentTransactions.blockTime, since)));

    const tx24h = txRow?.tx24h ?? 0;
    const successCount = txRow?.successCount ?? 0;
    const solDelta24h = txRow?.solDelta24h ?? '0';
    const successRate24h = tx24h > 0 ? successCount / tx24h : null;

    const [activeRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(agents)
      .where(and(eq(agents.userId, user.id), eq(agents.status, 'live')));
    const activeAgents = activeRow?.count ?? 0;

    const [alertRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(alerts)
      .innerJoin(agents, eq(alerts.agentId, agents.id))
      .where(
        and(
          eq(agents.userId, user.id),
          eq(alerts.severity, 'critical'),
          gte(alerts.triggeredAt, since),
        ),
      );
    const criticalAlerts = alertRow?.count ?? 0;

    return c.json({
      tx24h,
      solDelta24h,
      successRate24h,
      activeAgents,
      criticalAlerts,
    });
  });

  return router;
}
