/**
 * Cross-agent stats routes.
 *
 * 13.1 — GET /api/stats/overview     → aggregate KPIs for the Overview page.
 * 13.9 — GET /api/stats/timeseries   → bucket-aggregated series for sparklines.
 *
 * Every aggregate is scoped to the authenticated user via an INNER JOIN
 * on `agents.user_id`. The 24h window for /overview matches the existing
 * convention used by `GET /api/agents/:id` (RECENT_TX_WINDOW_MS in
 * routes/agents.ts).
 *
 * `solDelta*` fields are returned as strings because
 * `agent_transactions.sol_delta` is `numeric(20,9)` — lamport precision
 * overflows JS number. Dashboards that only need the integer SOL part
 * can parseFloat; anyone who actually cares about the 9 decimals can
 * use a BigInt/decimal library.
 */

import { type Database, agentTransactions, agents, alerts } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

/** 24h rolling window for overview KPIs. Matches RECENT_TX_WINDOW_MS in agents.ts. */
const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Window → milliseconds. Kept as a closed set so callers cannot probe arbitrary ranges. */
const WINDOW_MS: Record<'24h' | '7d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/** Bucket → PostgreSQL `date_trunc` unit + interval literal used by generate_series. */
const BUCKET_SQL: Record<'1h' | '1d', { trunc: string; interval: string }> = {
  '1h': { trunc: 'hour', interval: '1 hour' },
  '1d': { trunc: 'day', interval: '1 day' },
};

const timeseriesQuerySchema = z.object({
  window: z.enum(['24h', '7d']).default('24h'),
  bucket: z.enum(['1h', '1d']).default('1h'),
  metric: z.enum(['tx', 'solDelta', 'successRate']).default('tx'),
});

/**
 * Drivers disagree on the shape of `db.execute()` results — postgres-js
 * returns an array-like `RowList`, pglite returns `{rows, fields, ...}`.
 * This normalizes both into a plain array without coupling route code to
 * either driver. Keeping the helper file-local for now; if a third route
 * needs it, promote to a shared lib.
 */
function unwrapRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const withRows = raw as { rows?: T[] };
  return withRows.rows ?? [];
}

interface TimeseriesRow {
  t: string;
  tx_count: number | string;
  sol_delta_sum: string;
  success_count: number | string;
}

export function createStatsRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get('/overview', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);
    const since = new Date(Date.now() - STATS_WINDOW_MS).toISOString();

    // Three independent aggregates run in parallel — latency becomes the
    // slowest of the three round-trips instead of their sum. Scoped via
    // INNER JOIN so foreign rows drop before each aggregation runs.
    // `sum()` in drizzle `numeric` mode already returns string, so the
    // `::text` cast is dropped — it was a no-op that just confused readers.
    const [txRows, activeRows, alertRows] = await Promise.all([
      db
        .select({
          tx24h: sql<number>`cast(count(*) as int)`,
          solDelta24h: sql<string>`coalesce(sum(${agentTransactions.solDelta}), 0)`,
          successCount: sql<number>`cast(count(*) filter (where ${agentTransactions.success}) as int)`,
        })
        .from(agentTransactions)
        .innerJoin(agents, eq(agentTransactions.agentId, agents.id))
        .where(and(eq(agents.userId, user.id), gte(agentTransactions.blockTime, since))),
      db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(agents)
        .where(and(eq(agents.userId, user.id), eq(agents.status, 'live'))),
      db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(alerts)
        .innerJoin(agents, eq(alerts.agentId, agents.id))
        .where(
          and(
            eq(agents.userId, user.id),
            eq(alerts.severity, 'critical'),
            gte(alerts.triggeredAt, since),
          ),
        ),
    ]);

    const txRow = txRows[0];
    const tx24h = txRow?.tx24h ?? 0;
    const successCount = txRow?.successCount ?? 0;
    const solDelta24h = txRow?.solDelta24h ?? '0';
    const successRate24h = tx24h > 0 ? successCount / tx24h : null;
    const activeAgents = activeRows[0]?.count ?? 0;
    const criticalAlerts = alertRows[0]?.count ?? 0;

    return c.json({
      tx24h,
      solDelta24h,
      successRate24h,
      activeAgents,
      criticalAlerts,
    });
  });

  /**
   * 13.9 — GET /timeseries?window=24h|7d&bucket=1h|1d&metric=tx|solDelta|successRate
   *
   * Returns `[{t, value}]` where `t` is the ISO bucket start and `value`
   * is the requested metric. Empty buckets are filled with zero via
   * `generate_series` LEFT JOIN so the client can assume a dense series
   * aligned to the window grid — no missing points, no client-side gap
   * filling, no surprises when an agent is quiet for an hour.
   *
   * Shape choice: the `value` key is a number for `tx` and `successRate`,
   * a string for `solDelta` (numeric(20,9) precision). `successRate` is
   * `null` for buckets with zero tx — a bucket with one failed tx has
   * rate 0, whereas a bucket with no tx has no rate at all; collapsing
   * those into the same numeric would lie about the data.
   */
  router.get(
    '/timeseries',
    zValidator('query', timeseriesQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { window, bucket, metric } = c.req.valid('query');
      const user = await ensureUser(db, privyDid);

      const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();
      const { trunc, interval } = BUCKET_SQL[bucket];

      // Single round trip: generate_series creates the bucket grid, LEFT
      // JOIN fills each bucket with its aggregates (or zero). All three
      // metrics are computed regardless of `metric` so we can swap the
      // projection without a second query — the per-bucket aggregation
      // cost is identical whichever metric the client asked for.
      const raw = await db.execute(sql`
        with buckets as (
          select t from generate_series(
            date_trunc(${trunc}, (${since})::timestamptz),
            date_trunc(${trunc}, now()),
            (${interval})::interval
          ) as t
        ),
        agg as (
          select
            date_trunc(${trunc}, ${agentTransactions.blockTime}) as t,
            count(*) as tx_count,
            coalesce(sum(${agentTransactions.solDelta}), 0) as sol_delta_sum,
            count(*) filter (where ${agentTransactions.success}) as success_count
          from ${agentTransactions}
          inner join ${agents} on ${agentTransactions.agentId} = ${agents.id}
          where ${agents.userId} = ${user.id}
            and ${agentTransactions.blockTime} >= ${since}
          group by 1
        )
        select
          to_char(b.t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t,
          coalesce(agg.tx_count, 0)::text as tx_count,
          coalesce(agg.sol_delta_sum, 0)::text as sol_delta_sum,
          coalesce(agg.success_count, 0)::text as success_count
        from buckets b
        left join agg on b.t = agg.t
        order by b.t asc
      `);

      const rows = unwrapRows<TimeseriesRow>(raw);

      const points = rows.map((row) => {
        const txCount =
          typeof row.tx_count === 'number' ? row.tx_count : Number.parseInt(row.tx_count, 10);
        const successCount =
          typeof row.success_count === 'number'
            ? row.success_count
            : Number.parseInt(row.success_count, 10);
        const value =
          metric === 'tx'
            ? txCount
            : metric === 'solDelta'
              ? row.sol_delta_sum
              : txCount > 0
                ? successCount / txCount
                : null;
        return { t: row.t, value };
      });

      return c.json({ window, bucket, metric, points });
    },
  );

  return router;
}
