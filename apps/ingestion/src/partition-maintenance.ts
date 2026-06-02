/**
 * Partition maintenance for agent_transactions (post-MVP storage hygiene).
 *
 * `agent_transactions` is RANGE-partitioned by `block_time` into monthly child
 * tables (migration 0001). That migration only created partitions through
 * 2026-09 with an explicit note that "future months should be added by a
 * maintenance cron job (post-MVP)". Without that job, every transaction after
 * 2026-10-01 lands in the DEFAULT partition — defeating partition pruning and
 * making retention drops impossible (you cannot DROP the default partition
 * without losing the current month's rows).
 *
 * This module fills that gap with two operations:
 *   - {@link ensureFuturePartitions} — roll partitions forward. Purely additive
 *     and idempotent; safe to run on every worker boot.
 *   - {@link dropOldPartitions} — optional TTL drop of months older than the
 *     retention window, to keep us inside the Supabase free-tier 500 MB cap.
 *     OPT-IN via `TX_RETENTION_MONTHS`: deleting a user's transaction history
 *     is a product decision, not a silent default, so drops are disabled
 *     unless a positive retention is configured.
 *
 * Both run on a slow (daily) timer inside the ingestion worker — same
 * single-process model as the detector cron, no separate deployment.
 */

import type { Database } from '@agentscope/db';
import { sql } from 'drizzle-orm';

const PARENT_TABLE = 'agent_transactions';
const PARTITION_PREFIX = 'agent_transactions_';
/**
 * Matches a dated monthly partition `agent_transactions_YYYY_MM`. Deliberately
 * does NOT match `agent_transactions_default` — the default partition must
 * never be dropped (it holds backfilled history and any out-of-range rows).
 */
const MONTHLY_PARTITION_RE = /^agent_transactions_(\d{4})_(\d{2})$/;

/** 24 hours — partition windows are monthly, so once a day is plenty. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimal structural logger (pino satisfies this). */
export interface MaintenanceLogger {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
}

/**
 * Drivers disagree on the shape of `db.execute()` results — postgres-js
 * returns an array-like `RowList`, pglite returns `{rows, fields, ...}`.
 * Normalize both into a plain array. (Same helper as api/src/routes/stats.ts;
 * kept file-local rather than promoted to a shared lib for one more consumer.)
 */
function unwrapRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const withRows = raw as { rows?: T[] };
  return withRows.rows ?? [];
}

/** First day of `date`'s month at 00:00:00 UTC. */
function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** `n` months after `monthStart` (UTC, day pinned to the 1st). */
function addMonthsUtc(monthStart: Date, n: number): Date {
  return new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + n, 1));
}

/** Partition table name for the month containing `monthStart`. */
function partitionName(monthStart: Date): string {
  const y = monthStart.getUTCFullYear();
  const m = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
  return `${PARTITION_PREFIX}${y}_${m}`;
}

/** Postgres `timestamptz` literal for a UTC month boundary. */
function tsLiteral(monthStart: Date): string {
  const y = monthStart.getUTCFullYear();
  const m = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01 00:00:00+00`;
}

/**
 * Enumerate the existing child partitions of `agent_transactions` via the
 * Postgres inheritance catalog. Returns raw `relname`s (includes the default
 * partition; callers filter as needed).
 */
async function listChildPartitions(db: Database): Promise<string[]> {
  const raw = await db.execute(sql`
    SELECT child.relname AS relname
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = ${PARENT_TABLE}
  `);
  return unwrapRows<{ relname: string }>(raw).map((r) => r.relname);
}

/**
 * Create monthly partitions for the current month through `monthsAhead`
 * months out. Idempotent: skips months whose partition already exists and
 * additionally guards with `CREATE TABLE IF NOT EXISTS`.
 *
 * Identifiers and bounds are derived from integers (year/month), so the
 * raw SQL is injection-safe despite not being parameterized — Postgres has
 * no bind-parameter form for DDL identifiers anyway.
 *
 * Returns the names of partitions that did not previously exist (newly
 * created this run).
 */
export async function ensureFuturePartitions(
  db: Database,
  opts: { monthsAhead: number; now?: Date; logger?: MaintenanceLogger },
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const currentMonth = startOfMonthUtc(now);
  const existing = new Set(await listChildPartitions(db));
  const created: string[] = [];

  for (let i = 0; i <= opts.monthsAhead; i++) {
    const from = addMonthsUtc(currentMonth, i);
    const to = addMonthsUtc(currentMonth, i + 1);
    const name = partitionName(from);
    if (existing.has(name)) continue;

    try {
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${PARENT_TABLE}" ` +
            `FOR VALUES FROM ('${tsLiteral(from)}') TO ('${tsLiteral(to)}')`,
        ),
      );
      // Match the parent's RLS state. Postgres does NOT propagate RLS to
      // partitions, and Supabase PostgREST exposes each partition as its own
      // /rest/v1/<name> endpoint — so a freshly rolled-forward partition would
      // be readable by anon/authenticated, bypassing tx_owner_access. Enable
      // RLS (no policies → default-deny for non-BYPASSRLS roles; our service
      // role is unaffected). Idempotent: enabling already-on RLS is a no-op.
      // This is the runtime counterpart to migration 0014 (existing
      // partitions) — without it every new month would regress the fix.
      await db.execute(sql.raw(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`));
      created.push(name);
    } catch (err) {
      // Most likely cause: the DEFAULT partition already holds rows in this
      // range because the job ran late (after rows for the month arrived).
      // Postgres refuses to attach an overlapping partition in that case.
      // Log and continue — the default still captures the rows, so ingestion
      // is never blocked; only partition pruning/retention is degraded until
      // the default is repacked manually.
      opts.logger?.warn({ err, partition: name }, 'failed to ensure partition');
    }
  }

  return created;
}

/**
 * Drop dated monthly partitions whose entire range is older than the
 * retention window. With `retentionMonths = N`, the current month plus the
 * previous `N − 1` months are kept; anything older is dropped.
 *
 * Never touches `agent_transactions_default` (regex-excluded) or the parent.
 * A no-op when `retentionMonths <= 0`.
 *
 * Returns the names of partitions that were dropped.
 */
export async function dropOldPartitions(
  db: Database,
  opts: { retentionMonths: number; now?: Date; logger?: MaintenanceLogger },
): Promise<string[]> {
  if (opts.retentionMonths <= 0) return [];

  const now = opts.now ?? new Date();
  // Oldest month to KEEP. e.g. retention=3, now=2026-06 → keep from 2026-04.
  const cutoff = addMonthsUtc(startOfMonthUtc(now), -(opts.retentionMonths - 1));
  const dropped: string[] = [];

  for (const relname of await listChildPartitions(db)) {
    const match = MONTHLY_PARTITION_RE.exec(relname);
    if (!match) continue; // skips the default partition and any odd names
    const year = Number(match[1]);
    const month = Number(match[2]); // 1-based
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    if (monthStart >= cutoff) continue; // still within retention

    try {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${relname}"`));
      dropped.push(relname);
    } catch (err) {
      opts.logger?.error({ err, partition: relname }, 'failed to drop old partition');
    }
  }

  return dropped;
}

/** Run one full maintenance pass (roll forward, then optional TTL drop). */
export async function runPartitionMaintenance(deps: {
  db: Database;
  logger: MaintenanceLogger;
  monthsAhead: number;
  retentionMonths: number;
  now?: Date;
}): Promise<{ created: string[]; dropped: string[] }> {
  const created = await ensureFuturePartitions(deps.db, {
    monthsAhead: deps.monthsAhead,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const dropped = await dropOldPartitions(deps.db, {
    retentionMonths: deps.retentionMonths,
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
  });

  if (created.length > 0 || dropped.length > 0) {
    deps.logger.info({ created, dropped }, 'partition maintenance completed');
  }
  return { created, dropped };
}

export interface PartitionMaintenanceDeps {
  db: Database;
  logger: MaintenanceLogger;
  /** How many months ahead to pre-create partitions for. */
  monthsAhead: number;
  /** Retention window in months; `<= 0` disables TTL drops. */
  retentionMonths: number;
  /** Override the timer interval (tests). Default 24h. */
  intervalMs?: number;
}

/**
 * Start the daily partition-maintenance loop. Runs once immediately (so a
 * fresh deploy pre-creates upcoming months right away) then on `intervalMs`.
 * Returns a stop function for graceful shutdown.
 */
export function startPartitionMaintenance(deps: PartitionMaintenanceDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;

  const tick = (): void => {
    if (running) return; // skip if a prior pass is still going
    running = true;
    runPartitionMaintenance(deps)
      .catch((err) => deps.logger.error({ err }, 'partition maintenance failed'))
      .finally(() => {
        running = false;
      });
  };

  tick(); // immediate first pass on boot
  const timer = setInterval(tick, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
