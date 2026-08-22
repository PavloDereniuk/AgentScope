/**
 * `GET /health/ingestion` — liveness of the ingestion worker (E.13).
 *
 * The API's own `/health` says nothing about ingestion: they are separate
 * processes with separate failure modes. On 2026-07-30 ingestion crash-looped
 * on an INSERT with an unknown enum value and stayed dead for twelve days —
 * no transactions, no alerts — while `/health` returned 200 the entire time,
 * because the API was genuinely fine. This endpoint is the missing half, and
 * `.github/workflows/keep-alive.yml` is the thing that watches it.
 *
 * The reading is deliberately strict about *silence*, not about traffic:
 *
 *   - a stale heartbeat means the worker is down or wedged;
 *   - a stale slot means the WebSocket stopped delivering while the process
 *     stayed up, which is invisible from the outside and just as fatal;
 *   - a stale cron cycle means the time-based rules (stale_agent, drawdown,
 *     low_balance) are no longer being evaluated;
 *   - a stale *transaction* means nothing at all. A quiet fleet is normal, so
 *     tx age is reported and never judged.
 *
 * A signal that has never fired is aged from process start, not treated as
 * instantly stale — a worker three seconds into its boot has legitimately not
 * seen a slot yet.
 */

import { type Database, serviceHeartbeats } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

/** Service key written by the ingestion worker's heartbeat. */
const INGESTION_SERVICE = 'ingestion';

export interface IngestionHealthThresholds {
  /** Max age of the heartbeat row itself. Writer cadence is 30s. */
  maxBeatAgeSec: number;
  /** Max gap between WebSocket slot notifications (~2.5/s when healthy). */
  maxSlotAgeSec: number;
  /** Max gap between completed cron cycles (cadence 60s). */
  maxCronAgeSec: number;
}

export const DEFAULT_INGESTION_HEALTH_THRESHOLDS: IngestionHealthThresholds = {
  // 6x the 30s write cadence: one slow write or one lost tick is not an
  // outage, and a real crash-loop is well past this within one check interval.
  maxBeatAgeSec: 180,
  // Slots arrive every ~400ms on mainnet. Five minutes of silence is not a
  // hiccup — it is a subscription that never came back after a reconnect.
  maxSlotAgeSec: 300,
  // 5x the 60s cron cadence. Cycles that overlap get skipped by design, so a
  // couple of skipped ticks under load must not read as failure.
  maxCronAgeSec: 300,
};

export type IngestionHealthReason =
  | 'never-reported'
  | 'stale-heartbeat'
  | 'stream-stalled'
  | 'cron-stalled';

/** The row shape this module reads. Detail is untrusted, hence `unknown`. */
export interface HeartbeatRecord {
  beatAt: string | Date;
  detail: Record<string, unknown> | null;
}

export interface IngestionHealth {
  ok: boolean;
  service: string;
  reason?: IngestionHealthReason;
  /** Seconds since the worker last wrote its heartbeat row. */
  beatAgeSeconds: number | null;
  /** Seconds since the last WebSocket slot, or since boot if none yet. */
  slotAgeSeconds: number | null;
  /** Seconds since the last completed cron cycle, or since boot if none yet. */
  cronAgeSeconds: number | null;
  /** Seconds since the last ingested transaction. Reported, never judged. */
  txAgeSeconds: number | null;
  registeredAgents: number | null;
  startedAt: string | null;
}

/** Parse an ISO timestamp into epoch ms, tolerating anything at all. */
function parseTime(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Age in seconds, millisecond resolution. Negative clock skew clamps to 0. */
function ageSeconds(fromMs: number | null, nowMs: number): number | null {
  if (fromMs === null) return null;
  return Math.max(0, Math.round(nowMs - fromMs) / 1000);
}

/**
 * Decide whether the ingestion worker is healthy from its heartbeat row.
 *
 * Pure: no clock, no database. `row` is null when the worker has never
 * reported — a fresh deployment, or a worker that has never once booted far
 * enough to write.
 */
export function evaluateIngestionHealth(
  row: HeartbeatRecord | null,
  nowMs: number,
  thresholds: IngestionHealthThresholds = DEFAULT_INGESTION_HEALTH_THRESHOLDS,
): IngestionHealth {
  const base: IngestionHealth = {
    ok: false,
    service: INGESTION_SERVICE,
    beatAgeSeconds: null,
    slotAgeSeconds: null,
    cronAgeSeconds: null,
    txAgeSeconds: null,
    registeredAgents: null,
    startedAt: null,
  };

  if (row === null) {
    return { ...base, reason: 'never-reported' };
  }

  const detail = row.detail ?? {};
  const startedAtMs = parseTime(detail.startedAt);
  const beatAgeSec = ageSeconds(parseTime(row.beatAt), nowMs);

  // A signal that has never fired is aged from process start; a worker that
  // booted seconds ago has not missed anything yet. With no usable start time
  // either, the signal stays unknown rather than stale — the heartbeat age
  // above already covers the "worker is gone" case, and inventing staleness
  // here would page someone over a malformed jsonb field.
  const sinceStart = ageSeconds(startedAtMs, nowMs);
  const slotAgeSec = ageSeconds(parseTime(detail.lastSlotAt), nowMs) ?? sinceStart;
  const cronAgeSec = ageSeconds(parseTime(detail.lastCronTickAt), nowMs) ?? sinceStart;

  const health: IngestionHealth = {
    ...base,
    beatAgeSeconds: beatAgeSec,
    slotAgeSeconds: slotAgeSec,
    cronAgeSeconds: cronAgeSec,
    txAgeSeconds: ageSeconds(parseTime(detail.lastTxAt), nowMs),
    registeredAgents: typeof detail.registeredAgents === 'number' ? detail.registeredAgents : null,
    startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
  };

  if (beatAgeSec === null || beatAgeSec > thresholds.maxBeatAgeSec) {
    return { ...health, reason: 'stale-heartbeat' };
  }
  if (slotAgeSec !== null && slotAgeSec > thresholds.maxSlotAgeSec) {
    return { ...health, reason: 'stream-stalled' };
  }
  if (cronAgeSec !== null && cronAgeSec > thresholds.maxCronAgeSec) {
    return { ...health, reason: 'cron-stalled' };
  }

  return { ...health, ok: true };
}

export interface HealthRouterDeps {
  db: Database;
  thresholds?: IngestionHealthThresholds;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

/**
 * Router exposing `GET /health/ingestion`. No auth: it carries no user data
 * (a service name, ages in seconds, a fleet-wide agent count) and the uptime
 * checker that reads it holds no credentials.
 */
export function createHealthRouter(deps: HealthRouterDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const thresholds = deps.thresholds ?? DEFAULT_INGESTION_HEALTH_THRESHOLDS;

  app.get('/health/ingestion', async (c) => {
    let row: HeartbeatRecord | null = null;
    try {
      const rows = await deps.db
        .select({ beatAt: serviceHeartbeats.beatAt, detail: serviceHeartbeats.detail })
        .from(serviceHeartbeats)
        .where(eq(serviceHeartbeats.service, INGESTION_SERVICE))
        .limit(1);
      row = rows[0] ?? null;
    } catch {
      // The API cannot reach the database, so it cannot say anything about
      // ingestion. 503 with a distinct reason keeps the two apart in the alert.
      return c.json({ ok: false, service: INGESTION_SERVICE, reason: 'db-unavailable' }, 503);
    }

    const health = evaluateIngestionHealth(row, now(), thresholds);
    return c.json(health, health.ok ? 200 : 503);
  });

  return app;
}
