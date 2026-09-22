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

import { createHash } from 'node:crypto';
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
  /**
   * Owner identities, excluded from the milestone export. The grant counts
   * *external* builders ("not me, not test accounts"), and the owner DIDs are
   * the only test accounts the schema can name.
   */
  ownerDids: Set<string>;
  logger: Logger;
}

/**
 * The grant's own definition of an active builder (GRANT-SF-UKRAINE-AWARDED.md
 * §4): ≥1 tx ingested in the last 14 days OR ≥1 alert *delivered* in the
 * last 30 days. Distinct from the panel's internal "active" (any tx or span,
 * ever), which is what the overview cards keep reporting.
 */
const GRANT_TX_WINDOW_DAYS = 14;
const GRANT_ALERT_WINDOW_DAYS = 30;

/** Enough hex to keep a fleet of builders distinct while staying screenshot-sized. */
const BUILDER_HASH_LENGTH = 12;

/**
 * Anonymize a builder for the sponsor: a truncated SHA-256 of the Privy DID.
 * Stable across exports (the same builder hashes the same in M1 and M3), and
 * not reversible without the DID list, which never leaves this side.
 */
function hashBuilder(privyDid: string): string {
  return createHash('sha256').update(privyDid).digest('hex').slice(0, BUILDER_HASH_LENGTH);
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
async function fetchBuilderCounts(db: DbHandle): Promise<{ registered: number; active: number }> {
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

/**
 * Either the pooled client OR a pinned transaction handle — both expose the
 * same drizzle query surface. The aggregate fetchers accept this so `/summary`
 * can pass a single transaction (one pooled connection for ALL its queries),
 * while the individual endpoints keep passing the top-level `db`. See the
 * `/summary` handler note for why the transaction is load-bearing.
 */
type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

// ─── Aggregate fetchers ─────────────────────────────────────────────────────
// Extracted from the route handlers so both the individual endpoints AND the
// consolidated `/summary` endpoint share one implementation. Builder counts
// are passed in (not refetched) so `/summary` computes them once for both the
// overview and the milestones.

async function getOverview(db: DbHandle, builders: BuilderCounts) {
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

async function getInfra(db: DbHandle, logger: Logger) {
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

async function getBuildersTable(db: DbHandle) {
  const since30d = new Date(Date.now() - WINDOW_MS['30d']).toISOString();
  const since7d = new Date(Date.now() - WINDOW_MS['7d']).toISOString();
  const raw = await db.execute(sql`
    -- Pre-aggregate transactions PER AGENT first, then join that (one row per
    -- agent) onto users. The earlier version joined agent_transactions rows
    -- directly, so the users↔agents↔tx join fanned out to one row per
    -- transaction in the 30d window — tens/hundreds of thousands of rows —
    -- before the per-user GROUP BY + count(distinct) collapsed them. That
    -- fanout is what pushed /summary past the client's 60s timeout. Folding tx
    -- to per-agent counts up front (via the tx_agent_time_idx index) keeps the
    -- outer join at users×agents scale. Window is still bounded to 30d, so
    -- tx_30d / last_tx carry the same 30d semantics as before.
    with tx_agg as (
      select
        agent_id,
        cast(count(*) filter (where block_time >= ${since7d}) as int) as tx_7d,
        cast(count(*) as int) as tx_30d,
        max(block_time) as last_tx
      from agent_transactions
      where block_time >= ${since30d}
      group by agent_id
    )
    select
      u.id as user_id,
      u.privy_did,
      u.email,
      to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
      cast(count(distinct ag.id) as int) as agents,
      cast(coalesce(sum(txa.tx_7d), 0) as int) as tx_7d,
      cast(coalesce(sum(txa.tx_30d), 0) as int) as tx_30d,
      to_char(max(txa.last_tx) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_tx
    from users u
    left join agents ag on ag.user_id = u.id
    left join tx_agg txa on txa.agent_id = ag.id
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

async function getAlertsBreakdown(db: DbHandle, window: '24h' | '7d' | '30d') {
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

/** Exported for the empty-allowlist test — the router itself is unreachable without an owner. */
export async function getMilestoneExport(db: DbHandle, ownerDids: Set<string>) {
  const now = Date.now();
  const txSince = new Date(now - GRANT_TX_WINDOW_DAYS * WINDOW_MS['24h']).toISOString();
  const alertSince = new Date(now - GRANT_ALERT_WINDOW_DAYS * WINDOW_MS['24h']).toISOString();
  // Neither driver serializes a JS array as a Postgres array parameter, so
  // the owner list is spliced in as one parameter per DID. An empty allowlist
  // excludes nobody — `not in ()` is invalid SQL and `not in (null)` is NULL,
  // which would silently exclude everyone.
  const ownerList = sql.join(
    [...ownerDids].map((did) => sql`${did}`),
    sql`, `,
  );
  const isExternal = ownerDids.size > 0 ? sql`u.privy_did not in (${ownerList})` : sql`true`;
  const isOwnerUser = ownerDids.size > 0 ? sql`u.privy_did in (${ownerList})` : sql`false`;
  const raw = await db.execute(sql`
    -- Same shape as getBuildersTable: fold tx and alerts to one row per agent
    -- BEFORE joining onto users, so the join never fans out to raw rows.
    -- Unlike the panel table this one is unbounded in time — the M1 proof is
    -- "≥1 tx ever", so first_tx must see the whole history. min/max ride
    -- tx_agent_time_idx; the recent count is a separate, time-bounded scan so
    -- the unbounded half never has to touch every row per agent.
    with tx_bounds as (
      select agent_id, min(block_time) as first_tx, max(block_time) as last_tx
      from agent_transactions
      group by agent_id
    ),
    tx_recent as (
      select agent_id, cast(count(*) as int) as tx_recent
      from agent_transactions
      where block_time >= ${txSince}
      group by agent_id
    ),
    alert_agg as (
      select
        agent_id,
        max(delivered_at) as last_delivered,
        cast(count(*) filter (where delivered_at >= ${alertSince}) as int) as delivered_recent
      from alerts
      where delivery_status = 'delivered'
      group by agent_id
    )
    select
      u.privy_did,
      to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as registered_at,
      cast(count(ag.id) as int) as agents_count,
      to_char(min(txb.first_tx) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_tx_at,
      to_char(max(txb.last_tx) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_tx_at,
      cast(coalesce(sum(txr.tx_recent), 0) as int) as tx_recent,
      cast(coalesce(sum(ala.delivered_recent), 0) as int) as delivered_recent,
      to_char(max(ala.last_delivered) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_alert_delivered_at
    from users u
    join agents ag on ag.user_id = u.id
    left join tx_bounds txb on txb.agent_id = ag.id
    left join tx_recent txr on txr.agent_id = ag.id
    left join alert_agg ala on ala.agent_id = ag.id
    where ${isExternal}
    group by u.id, u.privy_did, u.created_at
  `);
  const ownerRaw = await db.execute(sql`
    select cast(count(distinct u.id) as int) as n
    from users u
    join agents ag on ag.user_id = u.id
    where ${isOwnerUser}
  `);

  const builders = unwrapRows<{
    privy_did: string;
    registered_at: string;
    agents_count: number | string;
    first_tx_at: string | null;
    last_tx_at: string | null;
    tx_recent: number | string;
    delivered_recent: number | string;
    last_alert_delivered_at: string | null;
  }>(raw).map((r) => {
    const tx14d = Number(r.tx_recent);
    const alertsDelivered30d = Number(r.delivered_recent);
    // Whichever of the two windows fired most recently — the timestamp the
    // sponsor reads as "last seen" for this builder.
    const lastActiveAt =
      [tx14d > 0 ? r.last_tx_at : null, alertsDelivered30d > 0 ? r.last_alert_delivered_at : null]
        .filter((t): t is string => t != null)
        .sort()
        .at(-1) ?? null;
    return {
      builderHash: hashBuilder(r.privy_did),
      registeredAt: r.registered_at,
      agentsCount: Number(r.agents_count),
      firstTxAt: r.first_tx_at,
      lastTxAt: r.last_tx_at,
      tx14d,
      alertsDelivered30d,
      lastAlertDeliveredAt: r.last_alert_delivered_at,
      lastActiveAt,
      connected: r.first_tx_at != null,
      active: tx14d > 0 || alertsDelivered30d > 0,
    };
  });

  // Active first, then connected, then most recently active — the screenshot
  // leads with the rows that prove the milestone.
  builders.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
  });

  return {
    generatedAt: new Date(now).toISOString(),
    definition: { txWindowDays: GRANT_TX_WINDOW_DAYS, alertWindowDays: GRANT_ALERT_WINDOW_DAYS },
    excluded: { ownerUsers: Number(unwrapRows<{ n: number | string }>(ownerRaw)[0]?.n ?? 0) },
    counts: {
      registered: builders.length,
      connected: builders.filter((b) => b.connected).length,
      active: builders.filter((b) => b.active).length,
    },
    builders,
  };
}

export function createAdminRouter(deps: AdminRouterDeps) {
  const { db, milestones, ownerDids, logger } = deps;
  const router = new Hono<ApiEnv>();

  // Each endpoint delegates to a module-level fetcher (shared with /summary).
  router.get('/overview', async (c) => c.json(await getOverview(db, await fetchBuilderCounts(db))));

  router.get('/milestones', async (c) =>
    c.json(getMilestonesPayload(await fetchBuilderCounts(db), milestones)),
  );

  router.get('/infra', async (c) => c.json(await getInfra(db, logger)));

  router.get('/builders', async (c) => c.json(await getBuildersTable(db)));

  // Grant proof bundle (G.1): anonymized per-builder rows + counts by the
  // sponsor's definitions. Two queries on one connection, no fan-out.
  router.get('/milestone-export', async (c) => c.json(await getMilestoneExport(db, ownerDids)));

  router.get(
    '/alerts-breakdown',
    zValidator('query', breakdownQuerySchema, (result) => {
      if (!result.success) throw new HTTPException(422, { message: 'invalid window' });
    }),
    async (c) => c.json(await getAlertsBreakdown(db, c.req.valid('query').window)),
  );

  // Consolidated single-request payload for the dashboard panel.
  //
  // CRITICAL: every query runs inside ONE transaction, i.e. on a SINGLE pooled
  // connection. This is not for atomicity (these are read-only aggregates) —
  // it caps the whole endpoint at one connection from the app's small pool
  // (maxConnections: 5, see apps/api/src/server.ts).
  //
  // Why it matters: the individual fetchers fan out (getOverview alone fires 4
  // queries via Promise.all). Running all five groups against the top-level
  // `db` demanded ~7 simultaneous connections; with concurrent requests
  // (react-query retries, StrictMode double-mount, manual refreshes) two such
  // requests exhausted the 5-slot pool and DEADLOCKED — every /summary then hung
  // until the client's 60s fetch timeout (api-client.ts) aborted it with a 499,
  // leaving the whole panel stuck on "loading…". Reproduced against prod: pool
  // 5 + this fan-out hangs; pinning to one connection stays ~0.8s even at 8
  // concurrent. The queries themselves are all <150ms — speed was never the
  // issue, connection fan-out was.
  //
  // Inside the pinned connection the groups run sequentially; getOverview's
  // internal Promise.all is safe because those queries pipeline on the one
  // reserved connection rather than grabbing extra pool slots.
  router.get('/summary', async (c) => {
    // Time each group so a future slow-down is diagnosable from the logs alone
    // (we can't attach a profiler to prod). `timed` records wall-ms per group.
    const timings: Record<string, number> = {};
    const timed = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await work();
      } finally {
        timings[name] = Math.round(performance.now() - start);
      }
    };

    const payload = await db.transaction(async (tx) => {
      const builders = await timed('builderCounts', () => fetchBuilderCounts(tx));
      const overview = await timed('overview', () => getOverview(tx, builders));
      const infra = await timed('infra', () => getInfra(tx, logger));
      const buildersTable = await timed('buildersTable', () => getBuildersTable(tx));
      const alertsBreakdown = await timed('alertsBreakdown', () => getAlertsBreakdown(tx, '7d'));
      return {
        overview,
        milestones: getMilestonesPayload(builders, milestones),
        infra,
        builders: buildersTable,
        alertsBreakdown,
      };
    });

    logger.info({ timings }, 'admin/summary group timings (ms)');
    return c.json(payload);
  });

  return router;
}
