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
