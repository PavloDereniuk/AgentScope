/**
 * Tests for GET /health/ingestion (E.13 — ingestion liveness).
 *
 * Two layers: the pure `evaluateIngestionHealth` reading (every staleness
 * verdict, without a clock or a database) and the route wired into the real
 * app over PGlite, which proves the endpoint is anonymous, reads the row the
 * ingestion worker actually writes, and answers 503 rather than 200 when the
 * worker is silent.
 *
 * The scenario each case is written against is the July 2026 outage: the
 * worker was dead for twelve days, the transaction stream was empty, and the
 * API's own /health returned 200 the whole time.
 */

import { serviceHeartbeats } from '@agentscope/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import {
  DEFAULT_INGESTION_HEALTH_THRESHOLDS as T,
  evaluateIngestionHealth,
} from '../src/routes/health';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const tokenVerifier: AuthVerifier = {
  async verify(token: string) {
    return { userId: token };
  },
};

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

/** ISO timestamp `secondsAgo` before NOW. */
function ago(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

/** A healthy row: beat 10s ago, booted an hour ago, everything fresh. */
function healthyRow(overrides: Record<string, unknown> = {}) {
  return {
    beatAt: ago(10),
    detail: {
      startedAt: ago(3600),
      lastSlotAt: ago(1),
      lastTxAt: ago(420),
      lastCronTickAt: ago(45),
      registeredAgents: 57,
      ...overrides,
    },
  };
}

describe('evaluateIngestionHealth', () => {
  it('reports healthy when every signal is fresh', () => {
    const health = evaluateIngestionHealth(healthyRow(), NOW);
    expect(health.ok).toBe(true);
    expect(health.reason).toBeUndefined();
    expect(health.beatAgeSeconds).toBe(10);
    expect(health.slotAgeSeconds).toBe(1);
    expect(health.cronAgeSeconds).toBe(45);
    expect(health.registeredAgents).toBe(57);
  });

  it('reports never-reported when no row exists', () => {
    const health = evaluateIngestionHealth(null, NOW);
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('never-reported');
    expect(health.beatAgeSeconds).toBeNull();
  });

  it('reports stale-heartbeat once the row ages past the threshold', () => {
    const row = { ...healthyRow(), beatAt: ago(T.maxBeatAgeSec + 1) };
    const health = evaluateIngestionHealth(row, NOW);
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('stale-heartbeat');
  });

  it('tolerates one missed write — a beat inside the threshold is healthy', () => {
    const row = { ...healthyRow(), beatAt: ago(T.maxBeatAgeSec) };
    expect(evaluateIngestionHealth(row, NOW).ok).toBe(true);
  });

  it('reports stream-stalled when the process is up but slots stopped', () => {
    // The failure mode a plain process-liveness ping cannot see: the worker
    // is writing heartbeats, but its WebSocket subscription never came back.
    const health = evaluateIngestionHealth(
      healthyRow({ lastSlotAt: ago(T.maxSlotAgeSec + 60) }),
      NOW,
    );
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('stream-stalled');
    expect(health.slotAgeSeconds).toBe(T.maxSlotAgeSec + 60);
  });

  it('reports cron-stalled when cycles stop completing', () => {
    const health = evaluateIngestionHealth(
      healthyRow({ lastCronTickAt: ago(T.maxCronAgeSec + 1) }),
      NOW,
    );
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('cron-stalled');
  });

  it('never judges transaction age — a quiet fleet is healthy', () => {
    // Twelve days without a transaction is normal for a fleet of idle agents
    // and must not page anyone. Only silence from the worker itself does.
    const health = evaluateIngestionHealth(healthyRow({ lastTxAt: ago(12 * 86_400) }), NOW);
    expect(health.ok).toBe(true);
    expect(health.txAgeSeconds).toBe(12 * 86_400);
  });

  it('ages never-fired signals from process start, so a fresh boot is healthy', () => {
    const row = {
      beatAt: ago(1),
      detail: { startedAt: ago(3), lastSlotAt: null, lastTxAt: null, lastCronTickAt: null },
    };
    const health = evaluateIngestionHealth(row, NOW);
    expect(health.ok).toBe(true);
    expect(health.slotAgeSeconds).toBe(3);
    expect(health.cronAgeSeconds).toBe(3);
  });

  it('flags a worker that has been up for hours and never seen a slot', () => {
    const row = {
      beatAt: ago(1),
      detail: { startedAt: ago(7200), lastSlotAt: null, lastCronTickAt: ago(30) },
    };
    const health = evaluateIngestionHealth(row, NOW);
    expect(health.ok).toBe(false);
    expect(health.reason).toBe('stream-stalled');
  });

  it('does not invent staleness from a malformed detail payload', () => {
    // An older writer, or a corrupted field: the heartbeat itself is fresh,
    // which is the signal that matters. Unknown beats fabricated.
    const row = { beatAt: ago(5), detail: { startedAt: 'not-a-date', lastSlotAt: 42 } };
    const health = evaluateIngestionHealth(row, NOW);
    expect(health.ok).toBe(true);
    expect(health.slotAgeSeconds).toBeNull();
    expect(health.registeredAgents).toBeNull();
    expect(health.startedAt).toBeNull();
  });

  it('accepts a Date beatAt from drivers that hydrate timestamps', () => {
    const row = { beatAt: new Date(NOW - 5000), detail: healthyRow().detail };
    expect(evaluateIngestionHealth(row, NOW).beatAgeSeconds).toBe(5);
  });

  it('clamps negative ages from clock skew instead of reporting them', () => {
    const row = { ...healthyRow(), beatAt: new Date(NOW + 30_000).toISOString() };
    const health = evaluateIngestionHealth(row, NOW);
    expect(health.beatAgeSeconds).toBe(0);
    expect(health.ok).toBe(true);
  });
});

describe('GET /health/ingestion', () => {
  let ctx: { app: ReturnType<typeof buildApp>; testDb: TestDatabase };

  beforeEach(async () => {
    const testDb = await createTestDatabase();
    ctx = {
      testDb,
      app: buildApp({ db: testDb.db, verifier: tokenVerifier, sseBus: createSseBus() }),
    };
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  /** Write the heartbeat row the way the ingestion worker does. */
  async function writeHeartbeat(beatAt: string, detail: Record<string, unknown>): Promise<void> {
    await ctx.testDb.db
      .insert(serviceHeartbeats)
      .values({ service: 'ingestion', beatAt, detail })
      .onConflictDoUpdate({ target: serviceHeartbeats.service, set: { beatAt, detail } });
  }

  it('returns 503 with never-reported before the worker has ever run', async () => {
    const res = await ctx.app.request('/health/ingestion');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason: string; service: string };
    expect(body).toMatchObject({ ok: false, reason: 'never-reported', service: 'ingestion' });
  });

  it('returns 200 for a live worker, without any auth header', async () => {
    const now = Date.now();
    await writeHeartbeat(new Date(now - 5000).toISOString(), {
      startedAt: new Date(now - 600_000).toISOString(),
      lastSlotAt: new Date(now - 500).toISOString(),
      lastTxAt: new Date(now - 60_000).toISOString(),
      lastCronTickAt: new Date(now - 20_000).toISOString(),
      registeredAgents: 3,
    });

    const res = await ctx.app.request('/health/ingestion');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; registeredAgents: number };
    expect(body.ok).toBe(true);
    expect(body.registeredAgents).toBe(3);
  });

  it('returns 503 while /health still returns 200 — the July 2026 shape', async () => {
    const now = Date.now();
    await writeHeartbeat(new Date(now - 12 * 86_400_000).toISOString(), {
      startedAt: new Date(now - 12 * 86_400_000 - 60_000).toISOString(),
      lastSlotAt: new Date(now - 12 * 86_400_000).toISOString(),
      lastCronTickAt: new Date(now - 12 * 86_400_000).toISOString(),
      registeredAgents: 57,
    });

    const ingestion = await ctx.app.request('/health/ingestion');
    const api = await ctx.app.request('/health');

    expect(api.status).toBe(200);
    expect(ingestion.status).toBe(503);
    const body = (await ingestion.json()) as { reason: string; beatAgeSeconds: number };
    expect(body.reason).toBe('stale-heartbeat');
    expect(body.beatAgeSeconds).toBeGreaterThan(86_400);
  });
});
