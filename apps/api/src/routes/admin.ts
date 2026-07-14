/**
 * Owner-only admin / grant-ops routes (Cluster F).
 *
 * Unlike every other /api route — which scopes its reads to the
 * authenticated user via `eq(agents.userId, …)` — these endpoints aggregate
 * *across every user* on the platform. That is the whole point: the panel
 * exists so the platform owner can report grant milestones (builder counts)
 * and watch infra headroom. The owner-gate (`requireOwner`) is applied by
 * the caller before this router runs, so by the time any handler executes we
 * know the request is from an owner.
 *
 * Aggregation style mirrors `routes/stats.ts`: parallel `Promise.all` for
 * independent counts, `generate_series` for dense bucketed series. The only
 * difference is the absent user filter.
 *
 * "Builder" is reported as TWO numbers (owner decides which to file per
 * milestone): `registered` = distinct users owning ≥1 agent; `active` =
 * distinct users whose agent has produced ≥1 transaction OR reasoning span.
 */

import { type Database, agents, alerts } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Logger } from '../logger';
import type { ApiEnv } from '../middleware/auth';

/** Supabase free-tier database size cap. The whole infra story revolves around this. */
const DB_CAP_BYTES = 500 * 1024 * 1024;

/**
 * Helius free-tier agent ceiling under the current cost model — the point
 * where the monthly credit budget runs out (see docs/INFRA-CAPACITY.md).
 * Surfaced so the owner can see how close the live fleet is to the wall.
 * Static: it shifts only when the cost model changes, not per-request.
 */
const HELIUS_AGENT_CEILING = 23;

/**
 * Rough bytes-per-transaction estimate (raw_logs-dominated, post-TOAST) used
 * to project "days until the DB cap is hit" from the recent tx rate. Matches
 * the ~2.5 KB/tx figure in docs/INFRA-CAPACITY.md. Approximate by design —
 * the projection is a finger-in-the-air, labelled as such in the response.
 */
const BYTES_PER_TX_ESTIMATE = 2500;

/** Closed set of windows the breakdown / infra series accept. */
const WINDOW_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const breakdownQuerySchema = z.object({
  window: z.enum(['24h', '7d', '30d']).default('7d'),
});

export interface AdminMilestoneConfig {
  /** Ascending builder-count targets (e.g. [4, 10, 25]). */
  targets: number[];
  /** ISO deadline string, or null when unset. */
  deadline: string | null;
}

export interface AdminRouterDeps {
  db: Database;
  milestones: AdminMilestoneConfig;
  logger: Logger;
}

/**
 * Drivers disagree on `db.execute()` result shape — postgres-js returns an
 * array-like RowList, pglite returns `{rows}`. Normalize to a plain array.
 * (Third file-local copy after stats.ts + here; if a fourth consumer appears
 * this earns promotion to a shared lib — kept local for now to stay focused.)
 */
function unwrapRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  return (raw as { rows?: T[] }).rows ?? [];
}

/** Count distinct registered + active builders in one round trip. */
async function fetchBuilderCounts(db: Database): Promise<{ registered: number; active: number }> {
  // `filter` is applied before the distinct count, so `active` counts the
  // distinct users among agents that have ANY tx or reasoning span. Raw SQL
  // (not drizzle builder) because correlated EXISTS subqueries read cleaner
  // here than the equivalent query-builder incantation.
  const raw = await db.execute(sql`
    select
      cast(count(distinct user_id) as int) as registered,
      cast(count(distinct user_id) filter (
        where exists (select 1 from agent_transactions t where t.agent_id = agents.id)
           or exists (select 1 from reasoning_logs r where r.agent_id = agents.id)
      ) as int) as active
    from agents
  `);
  const row = unwrapRows<{ registered: number | string; active: number | string }>(raw)[0];
  return {
    registered: row ? Number(row.registered) : 0,
    active: row ? Number(row.active) : 0,
  };
}

/**
 * Compute milestone progress from a current builder count: the next
 * unreached target, how far through the ladder we are, and per-target
 * reached flags. Pure — unit-testable without a DB.
 */
function computeMilestones(
  count: number,
  targets: number[],
): {
  targets: { target: number; reached: boolean }[];
  nextTarget: number | null;
  reachedCount: number;
  progressToNext: number | null;
} {
  const flagged = targets.map((target) => ({ target, reached: count >= target }));
  const reachedCount = flagged.filter((t) => t.reached).length;
  const next = targets.find((t) => count < t) ?? null;
  // Progress toward the next target measured from the previous one, so the
  // bar reflects "distance covered in the current leg", not absolute zero.
  let progressToNext: number | null = null;
  if (next !== null) {
    const prev = [...targets].reverse().find((t) => count >= t) ?? 0;
    const span = next - prev;
    progressToNext = span > 0 ? Math.min(1, Math.max(0, (count - prev) / span)) : 0;
  }
  return { targets: flagged, nextTarget: next, reachedCount, progressToNext };
}

type BuilderCounts = { registered: number; active: number };

// ─── Aggregate fetchers ─────────────────────────────────────────────────────
// Extracted from the route handlers so both the individual endpoints AND the
// consolidated `/summary` endpoint share one implementation. Builder counts
// are passed in (not refetched) so `/summary` computes them once for both the
// overview and the milestones.

async function getOverview(db: Database, builders: BuilderCounts) {
  const since24h = new Date(Date.now() - WINDOW_MS['24h']).toISOString();
  const [statusRows, txRows, alertRows, spanRows] = await Promise.all([
    db.execute(sql`select status, cast(count(*) as int) as n from ${agents} group by status`),
    db.execute(sql`
      select
        cast(count(*) as int) as total,
        cast(count(*) filter (where block_time >= ${since24h}) as int) as last24h
      from agent_transactions
    `),
    db
      .select({ severity: alerts.severity, n: sql<number>`cast(count(*) as int)` })
      .from(alerts)
      .where(sql`${alerts.triggeredAt} >= ${since24h}`)
      .groupBy(alerts.severity),
    db.execute(sql`select cast(count(*) as int) as n from reasoning_logs`),
  ]);

  const statusByName = Object.fromEntries(
    unwrapRows<{ status: string; n: number | string }>(statusRows).map((r) => [
      r.status,
      Number(r.n),
    ]),
  );
  const txRow = unwrapRows<{ total: number | string; last24h: number | string }>(txRows)[0];
  const alertsBySeverity = Object.fromEntries(alertRows.map((r) => [r.severity, Number(r.n)]));
  const spanRow = unwrapRows<{ n: number | string }>(spanRows)[0];

  const liveAgents = statusByName.live ?? 0;
  const staleAgents = statusByName.stale ?? 0;
  const failedAgents = statusByName.failed ?? 0;

  return {
    builders,
    agents: {
      total: liveAgents + staleAgents + failedAgents,
      live: liveAgents,
      stale: staleAgents,
      failed: failedAgents,
    },
    transactions: {
      total: txRow ? Number(txRow.total) : 0,
      last24h: txRow ? Number(txRow.last24h) : 0,
    },
    alerts24h: {
      critical: alertsBySeverity.critical ?? 0,
      warning: alertsBySeverity.warning ?? 0,
      info: alertsBySeverity.info ?? 0,
    },
    reasoningSpansTotal: spanRow ? Number(spanRow.n) : 0,
  };
}

function getMilestonesPayload(builders: BuilderCounts, milestones: AdminMilestoneConfig) {
  return {
    builders,
    deadline: milestones.deadline,
    registered: computeMilestones(builders.registered, milestones.targets),
    active: computeMilestones(builders.active, milestones.targets),
  };
}

async function getInfra(db: Database, logger: Logger) {
  let dbBytes: number | null = null;
  try {
    const raw = await db.execute(sql`select pg_database_size(current_database()) as bytes`);
    const row = unwrapRows<{ bytes: number | string }>(raw)[0];
    dbBytes = row ? Number(row.bytes) : null;
  } catch (err) {
    logger.debug({ err }, 'pg_database_size unavailable — infra db size degraded to null');
  }

  const since7d = new Date(Date.now() - WINDOW_MS['7d']).toISOString();
  const probeRaw = await db.execute(sql`
    select
      extract(epoch from (now() - max(block_time))) as lag_seconds,
      cast(count(*) filter (where block_time >= ${since7d}) as int) as tx_7d
    from agent_transactions
  `);
  const probe = unwrapRows<{ lag_seconds: number | string | null; tx_7d: number | string }>(
    probeRaw,
  )[0];
  const ingestLagSeconds =
    probe?.lag_seconds == null ? null : Math.max(0, Math.round(Number(probe.lag_seconds)));
  const tx7d = probe ? Number(probe.tx_7d) : 0;
  const avgTxPerDay = tx7d / 7;

  const monitoredRaw = await db.execute(
    sql`select cast(count(*) as int) as n from ${agents} where status <> 'failed'`,
  );
  const monitoredAgents = Number(unwrapRows<{ n: number | string }>(monitoredRaw)[0]?.n ?? 0);

  const dbUsedPct = dbBytes == null ? null : dbBytes / DB_CAP_BYTES;
  const dailyGrowthBytes = avgTxPerDay * BYTES_PER_TX_ESTIMATE;
  const projectedDaysToCap =
    dbBytes == null || dailyGrowthBytes <= 0
      ? null
      : Math.max(0, Math.round((DB_CAP_BYTES - dbBytes) / dailyGrowthBytes));

  return {
    db: {
      bytes: dbBytes,
      capBytes: DB_CAP_BYTES,
      usedPct: dbUsedPct,
      avgTxPerDay7d: Math.round(avgTxPerDay * 100) / 100,
      projectedDaysToCap,
    },
    helius: { monitoredAgents, agentCeiling: HELIUS_AGENT_CEILING },
    ingestLagSeconds,
  };
}

async function getBuildersTable(db: Database) {
  const since30d = new Date(Date.now() - WINDOW_MS['30d']).toISOString();
  const since7d = new Date(Date.now() - WINDOW_MS['7d']).toISOString();
  const raw = await db.execute(sql`
    select
      u.id as user_id,
      u.privy_did,
      u.email,
      to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
      cast(count(distinct ag.id) as int) as agents,
      cast(count(t.id) filter (where t.block_time >= ${since7d}) as int) as tx_7d,
      cast(count(t.id) as int) as tx_30d,
      to_char(max(t.block_time) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_tx
    from users u
    left join agents ag on ag.user_id = u.id
    -- Bound the join to the 30d window directly (not just in a filter): an
    -- unbounded join scans every partition of a growing tx table and holds
    -- a pooled connection for seconds. We only report tx7d/tx30d/dormant, so
    -- rows older than 30d are irrelevant. tx_30d is then the full join count.
    left join agent_transactions t
      on t.agent_id = ag.id and t.block_time >= ${since30d}
    group by u.id, u.privy_did, u.email, u.created_at
    order by tx_7d desc, agents desc, u.created_at asc
  `);

  const builders = unwrapRows<{
    user_id: string;
    privy_did: string;
    email: string | null;
    created_at: string;
    agents: number | string;
    tx_7d: number | string;
    tx_30d: number | string;
    last_tx: string | null;
  }>(raw).map((r) => ({
    userId: r.user_id,
    privyDid: r.privy_did,
    email: r.email,
    createdAt: r.created_at,
    agents: Number(r.agents),
    tx7d: Number(r.tx_7d),
    tx30d: Number(r.tx_30d),
    lastTx: r.last_tx,
    dormant: Number(r.tx_30d) === 0,
  }));

  return { builders };
}

async function getAlertsBreakdown(db: Database, window: '24h' | '7d' | '30d') {
  const since = new Date(Date.now() - WINDOW_MS[window]).toISOString();
  const rows = await db
    .select({
      rule: alerts.ruleName,
      severity: alerts.severity,
      n: sql<number>`cast(count(*) as int)`,
    })
    .from(alerts)
    .where(sql`${alerts.triggeredAt} >= ${since}`)
    .groupBy(alerts.ruleName, alerts.severity);

  return {
    window,
    breakdown: rows.map((r) => ({ rule: r.rule, severity: r.severity, count: Number(r.n) })),
  };
}

export function createAdminRouter(deps: AdminRouterDeps) {
  const { db, milestones, logger } = deps;
  const router = new Hono<ApiEnv>();

  // Each endpoint delegates to a module-level fetcher (shared with /summary).
  router.get('/overview', async (c) => c.json(await getOverview(db, await fetchBuilderCounts(db))));

  router.get('/milestones', async (c) =>
    c.json(getMilestonesPayload(await fetchBuilderCounts(db), milestones)),
  );

  router.get('/infra', async (c) => c.json(await getInfra(db, logger)));

  router.get('/builders', async (c) => c.json(await getBuildersTable(db)));

  router.get(
    '/alerts-breakdown',
    zValidator('query', breakdownQuerySchema, (result) => {
      if (!result.success) throw new HTTPException(422, { message: 'invalid window' });
    }),
    async (c) => c.json(await getAlertsBreakdown(db, c.req.valid('query').window)),
  );

  // Consolidated single-request payload for the dashboard panel. Runs the
  // aggregate groups SEQUENTIALLY (one group at a time) rather than letting the
  // browser fire six parallel requests at a 5-connection pool — that contention
  // was stalling the whole panel. Builder counts are computed once and shared
  // by overview + milestones.
  router.get('/summary', async (c) => {
    const builders = await fetchBuilderCounts(db);
    const overview = await getOverview(db, builders);
    const milestonesPayload = getMilestonesPayload(builders, milestones);
    const infra = await getInfra(db, logger);
    const buildersTable = await getBuildersTable(db);
    const alertsBreakdown = await getAlertsBreakdown(db, '7d');
    return c.json({
      overview,
      milestones: milestonesPayload,
      infra,
      builders: buildersTable,
      alertsBreakdown,
    });
  });

  return router;
}
