/**
 * Integration tests for GET /api/stats/overview (task 13.1).
 *
 * Full buildApp pipeline over PGlite + fake verifier. Verifies the
 * aggregate shape, the 24h window boundary, ownership isolation (another
 * user's tx/alerts must never leak into the sums), and the null-valued
 * successRate24h fallback when the user has no tx in the window.
 */

import { agentTransactions, agents, alerts } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:user-42';
const BEARER = 'Bearer stub-token';

function makeVerifier(userId: string = PRIVY_DID): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

interface TestApp {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function setup(verifier: AuthVerifier = makeVerifier()): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier,
    sseBus: createSseBus(),
    logger: silentLogger,
  });
  return { app, testDb };
}

async function createAgent(
  ctx: TestApp,
  name: string,
  walletPubkey: string,
  token = BEARER,
): Promise<{ id: string }> {
  const res = await ctx.app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ walletPubkey, name, framework: 'custom', agentType: 'other' }),
  });
  if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
  const body = (await res.json()) as { agent: { id: string } };
  return { id: body.agent.id };
}

interface OverviewBody {
  tx24h: number;
  solDelta24h: string;
  successRate24h: number | null;
  activeAgents: number;
  criticalAlerts: number;
}

function getOverview(ctx: TestApp, token = BEARER) {
  return ctx.app.request('/api/stats/overview', { headers: { Authorization: token } });
}

describe('GET /api/stats/overview', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/stats/overview');
    expect(res.status).toBe(401);
  });

  it('returns zero-ish baseline when the user has no agents', async () => {
    const res = await getOverview(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;
    expect(body).toEqual({
      tx24h: 0,
      solDelta24h: '0',
      successRate24h: null,
      activeAgents: 0,
      criticalAlerts: 0,
    });
  });

  it('aggregates tx24h, solDelta24h, successRate24h within the 24h window', async () => {
    const a1 = await createAgent(ctx, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const now = new Date();
    const inside1 = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const inside2 = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
    const inside3 = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
    const outside = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: a1.id,
        signature: 'sig-1',
        slot: 100,
        blockTime: inside1,
        programId: '11111111111111111111111111111111',
        solDelta: '0.500000000',
        success: true,
      },
      {
        agentId: a1.id,
        signature: 'sig-2',
        slot: 101,
        blockTime: inside2,
        programId: '11111111111111111111111111111111',
        solDelta: '-0.250000000',
        success: true,
      },
      {
        agentId: a2.id,
        signature: 'sig-3',
        slot: 102,
        blockTime: inside3,
        programId: '11111111111111111111111111111111',
        solDelta: '0.125000000',
        success: false,
      },
      {
        agentId: a1.id,
        signature: 'sig-4-old',
        slot: 10,
        blockTime: outside,
        programId: '11111111111111111111111111111111',
        solDelta: '99.000000000',
        success: true,
      },
    ]);

    const res = await getOverview(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OverviewBody;
    expect(body.tx24h).toBe(3);
    // 0.5 + (-0.25) + 0.125 = 0.375 — the 99 SOL outside the window must not leak in
    expect(Number.parseFloat(body.solDelta24h)).toBeCloseTo(0.375, 9);
    // 2 successes out of 3 tx in window
    expect(body.successRate24h).not.toBeNull();
    expect(body.successRate24h).toBeCloseTo(2 / 3, 6);
  });

  it('counts activeAgents as agents with status=live', async () => {
    const a1 = await createAgent(ctx, 'Live1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'Live2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await createAgent(ctx, 'Stale', 'StakeSSzfxn391k3LvdKbZP5WVwWd6AsY1DNiXHjQfK');
    // Flip two agents to status=live; the third stays at the schema default ('stale')
    await ctx.testDb.db.update(agents).set({ status: 'live' }).where(eq(agents.id, a1.id));
    await ctx.testDb.db.update(agents).set({ status: 'live' }).where(eq(agents.id, a2.id));

    const res = await getOverview(ctx);
    const body = (await res.json()) as OverviewBody;
    expect(body.activeAgents).toBe(2);
  });

  it('counts criticalAlerts only inside the 24h window', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const now = new Date();
    const inside = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const outside = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: agent.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: inside,
      },
      {
        agentId: agent.id,
        ruleName: 'slippage_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: inside,
      },
      {
        agentId: agent.id,
        ruleName: 'drawdown',
        severity: 'warning',
        payload: {},
        triggeredAt: inside,
      },
      {
        agentId: agent.id,
        ruleName: 'drawdown',
        severity: 'critical',
        payload: {},
        triggeredAt: outside,
      },
    ]);

    const res = await getOverview(ctx);
    const body = (await res.json()) as OverviewBody;
    expect(body.criticalAlerts).toBe(2);
  });

  it("never counts another user's tx/alerts", async () => {
    const aliceAgent = await createAgent(
      ctx,
      'Alice',
      'So11111111111111111111111111111111111111112',
    );
    const now = new Date();
    const inside = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: aliceAgent.id,
      signature: 'alice-sig',
      slot: 100,
      blockTime: inside,
      programId: '11111111111111111111111111111111',
      solDelta: '1.000000000',
      success: true,
    });
    await ctx.testDb.db.insert(alerts).values({
      agentId: aliceAgent.id,
      ruleName: 'gas_spike',
      severity: 'critical',
      payload: {},
      triggeredAt: inside,
    });

    // A different user shares the same DB — everything above must stay invisible to them.
    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request('/api/stats/overview', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as OverviewBody;
    expect(body).toEqual({
      tx24h: 0,
      solDelta24h: '0',
      successRate24h: null,
      activeAgents: 0,
      criticalAlerts: 0,
    });
  });
});

interface TimeseriesPoint {
  t: string;
  value: number | string | null;
}
interface TimeseriesBody {
  window: '24h' | '7d';
  bucket: '1h' | '1d';
  metric: 'tx' | 'solDelta' | 'successRate';
  agentId: string | null;
  points: TimeseriesPoint[];
}

function getTimeseries(ctx: TestApp, query = '', token = BEARER) {
  return ctx.app.request(`/api/stats/timeseries${query}`, { headers: { Authorization: token } });
}

describe('GET /api/stats/timeseries', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/stats/timeseries');
    expect(res.status).toBe(401);
  });

  it('rejects invalid window/bucket/metric with 422', async () => {
    const bad = await getTimeseries(ctx, '?window=1m');
    expect(bad.status).toBe(422);
    const bad2 = await getTimeseries(ctx, '?bucket=5m');
    expect(bad2.status).toBe(422);
    const bad3 = await getTimeseries(ctx, '?metric=pnl');
    expect(bad3.status).toBe(422);
  });

  it('defaults to window=24h bucket=1h metric=tx and returns 24 or 25 dense zero-filled points', async () => {
    const res = await getTimeseries(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimeseriesBody;
    expect(body.window).toBe('24h');
    expect(body.bucket).toBe('1h');
    expect(body.metric).toBe('tx');
    // Window is exactly 24h but `now` usually sits inside an hour — the
    // grid from `date_trunc('hour', since)` to `date_trunc('hour', now)`
    // is therefore 24 or 25 points depending on the minute of the hour.
    expect(body.points.length).toBeGreaterThanOrEqual(24);
    expect(body.points.length).toBeLessThanOrEqual(25);
    // Every point must be zero-filled (no agents seeded).
    for (const p of body.points) {
      expect(p.value).toBe(0);
    }
  });

  it('aggregates tx counts per hour bucket', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    // Anchor on the previous hour boundary so the two "same bucket" tx are
    // guaranteed to share `date_trunc('hour', ts)` regardless of the current
    // minute-of-hour. Picking relative offsets from `now` would collapse
    // into one bucket if `now` sat late in an hour, and split into two if
    // `now` sat early — flaky either way.
    const nowMs = Date.now();
    const hourMs = 60 * 60 * 1000;
    const currentHourStart = nowMs - (nowMs % hourMs);
    const prevHourStart = currentHourStart - hourMs;
    const sameBucket1 = new Date(prevHourStart + 5 * 60 * 1000).toISOString();
    const sameBucket2 = new Date(prevHourStart + 30 * 60 * 1000).toISOString();
    const threeHoursAgo = new Date(prevHourStart - 3 * hourMs + 10 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: agent.id,
        signature: 'sig-a',
        slot: 100,
        blockTime: sameBucket1,
        programId: '11111111111111111111111111111111',
        solDelta: '0.100000000',
        success: true,
      },
      {
        agentId: agent.id,
        signature: 'sig-b',
        slot: 101,
        blockTime: sameBucket2,
        programId: '11111111111111111111111111111111',
        solDelta: '0.200000000',
        success: false,
      },
      {
        agentId: agent.id,
        signature: 'sig-c',
        slot: 102,
        blockTime: threeHoursAgo,
        programId: '11111111111111111111111111111111',
        solDelta: '0.300000000',
        success: true,
      },
    ]);

    const res = await getTimeseries(ctx, '?metric=tx');
    const body = (await res.json()) as TimeseriesBody;
    const nonZero = body.points.filter((p) => p.value !== 0);
    // Two distinct hour buckets had tx: the 1h-ago bucket (2 tx) and the 3h-ago bucket (1 tx).
    expect(nonZero).toHaveLength(2);
    const values = nonZero.map((p) => p.value).sort();
    expect(values).toEqual([1, 2]);
    // Total across all points equals the total tx we seeded.
    const total = body.points.reduce((sum, p) => sum + (typeof p.value === 'number' ? p.value : 0), 0);
    expect(total).toBe(3);
  });

  it('returns solDelta as numeric strings, preserving lamport precision', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const now = new Date();
    const inside = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: agent.id,
        signature: 'sig-1',
        slot: 100,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.123456789',
        success: true,
      },
      {
        agentId: agent.id,
        signature: 'sig-2',
        slot: 101,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.000000001',
        success: true,
      },
    ]);

    const res = await getTimeseries(ctx, '?metric=solDelta');
    const body = (await res.json()) as TimeseriesBody;
    const nonZero = body.points.filter((p) => p.value !== '0' && p.value !== 0);
    expect(nonZero).toHaveLength(1);
    // Stored as string so 9 decimals survive the JSON round-trip.
    expect(typeof nonZero[0]?.value).toBe('string');
    expect(Number.parseFloat(nonZero[0]?.value as string)).toBeCloseTo(0.12345679, 8);
  });

  it('successRate is null in empty buckets and a ratio elsewhere', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const now = new Date();
    const inside = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: agent.id,
        signature: 'sig-ok',
        slot: 100,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.1',
        success: true,
      },
      {
        agentId: agent.id,
        signature: 'sig-fail',
        slot: 101,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.1',
        success: false,
      },
    ]);

    const res = await getTimeseries(ctx, '?metric=successRate');
    const body = (await res.json()) as TimeseriesBody;
    const withData = body.points.filter((p) => p.value !== null);
    const withoutData = body.points.filter((p) => p.value === null);
    expect(withData).toHaveLength(1);
    expect(withData[0]?.value).toBeCloseTo(0.5, 6);
    // Every other bucket must carry null — a bucket with zero tx has no rate.
    expect(withoutData.length).toBeGreaterThan(0);
  });

  it('7d/1d window returns 7 or 8 daily points', async () => {
    const res = await getTimeseries(ctx, '?window=7d&bucket=1d');
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimeseriesBody;
    expect(body.window).toBe('7d');
    expect(body.bucket).toBe('1d');
    expect(body.points.length).toBeGreaterThanOrEqual(7);
    expect(body.points.length).toBeLessThanOrEqual(8);
  });

  it('excludes tx outside the window', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const now = new Date();
    const outside = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: agent.id,
      signature: 'sig-old',
      slot: 100,
      blockTime: outside,
      programId: '11111111111111111111111111111111',
      solDelta: '99.000000000',
      success: true,
    });

    const res = await getTimeseries(ctx, '?window=24h&bucket=1h&metric=tx');
    const body = (await res.json()) as TimeseriesBody;
    for (const p of body.points) expect(p.value).toBe(0);
  });

  it('filters to a single agent when agentId is passed', async () => {
    const a1 = await createAgent(ctx, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const inside = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: a1.id,
        signature: 'sig-a1',
        slot: 100,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.1',
        success: true,
      },
      {
        agentId: a2.id,
        signature: 'sig-a2',
        slot: 101,
        blockTime: inside,
        programId: '11111111111111111111111111111111',
        solDelta: '0.2',
        success: true,
      },
    ]);

    const fleetRes = await getTimeseries(ctx, '?metric=tx');
    const fleetBody = (await fleetRes.json()) as TimeseriesBody;
    expect(fleetBody.agentId).toBeNull();
    const fleetTotal = fleetBody.points.reduce(
      (s, p) => s + (typeof p.value === 'number' ? p.value : 0),
      0,
    );
    expect(fleetTotal).toBe(2);

    const perAgent = await getTimeseries(ctx, `?metric=tx&agentId=${a1.id}`);
    const perAgentBody = (await perAgent.json()) as TimeseriesBody;
    expect(perAgentBody.agentId).toBe(a1.id);
    const perAgentTotal = perAgentBody.points.reduce(
      (s, p) => s + (typeof p.value === 'number' ? p.value : 0),
      0,
    );
    expect(perAgentTotal).toBe(1);
  });

  it("does not leak across tenants even when agentId is known", async () => {
    const aliceAgent = await createAgent(
      ctx,
      'Alice',
      'So11111111111111111111111111111111111111112',
    );
    const inside = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: aliceAgent.id,
      signature: 'alice-filter',
      slot: 100,
      blockTime: inside,
      programId: '11111111111111111111111111111111',
      solDelta: '1.0',
      success: true,
    });

    // Bob — different user — guesses Alice's agentId.
    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request(`/api/stats/timeseries?metric=tx&agentId=${aliceAgent.id}`, {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as TimeseriesBody;
    for (const p of body.points) expect(p.value).toBe(0);
  });

  it("never counts another user's tx", async () => {
    const aliceAgent = await createAgent(
      ctx,
      'Alice',
      'So11111111111111111111111111111111111111112',
    );
    const inside = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: aliceAgent.id,
      signature: 'alice-sig',
      slot: 100,
      blockTime: inside,
      programId: '11111111111111111111111111111111',
      solDelta: '1.0',
      success: true,
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request('/api/stats/timeseries?metric=tx', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as TimeseriesBody;
    for (const p of body.points) expect(p.value).toBe(0);
  });
});
