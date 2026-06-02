/**
 * Integration tests for the owner-only admin / grant-ops routes (Cluster F).
 *
 * Full buildApp pipeline over PGlite. The verifier maps the bearer token
 * straight to the Privy DID, so distinct `Authorization` headers create
 * distinct users — that's how we seed a multi-builder platform and then
 * query it as the owner.
 *
 * Covered: the owner gate (401 unauth / 403 non-owner / 200 owner), the
 * /api/me identity probe, builder counting (registered vs active), milestone
 * progress math, and the infra snapshot's graceful degradation.
 */

import { agentTransactions, alerts, reasoningLogs } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const OWNER = 'did:privy:owner';
const ALICE = 'did:privy:alice';
const BOB = 'did:privy:bob';

/** Token IS the DID — distinct tokens ⇒ distinct users via ensureUser. */
const tokenVerifier: AuthVerifier = {
  async verify(token: string) {
    return { userId: token };
  },
};

interface TestApp {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function setup(targets: number[] = [4, 10, 25]): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: tokenVerifier,
    sseBus: createSseBus(),
    ownerPrivyDids: new Set([OWNER]),
    adminMilestones: { targets, deadline: '2026-08-01' },
    logger: silentLogger,
  });
  return { app, testDb };
}

function bearer(did: string) {
  return { Authorization: `Bearer ${did}` };
}

/** Create an agent owned by `did`, returning its UUID. */
async function createAgent(
  ctx: TestApp,
  did: string,
  name: string,
  walletPubkey: string,
): Promise<string> {
  const res = await ctx.app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(did) },
    body: JSON.stringify({ walletPubkey, name, framework: 'custom', agentType: 'other' }),
  });
  if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
  const body = (await res.json()) as { agent: { id: string } };
  return body.agent.id;
}

async function insertTx(ctx: TestApp, agentId: string, signature: string, ageMs = 0) {
  await ctx.testDb.db.insert(agentTransactions).values({
    agentId,
    signature,
    slot: 1,
    blockTime: new Date(Date.now() - ageMs).toISOString(),
    programId: 'Sys1111111111111111111111111111111111111111',
    solDelta: '0',
    success: true,
  });
}

describe('admin owner gate', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/admin/overview');
    expect(res.status).toBe(401);
  });

  it('rejects authenticated non-owners with 403', async () => {
    const res = await ctx.app.request('/api/admin/overview', { headers: bearer(ALICE) });
    expect(res.status).toBe(403);
  });

  it('allows the owner', async () => {
    const res = await ctx.app.request('/api/admin/overview', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/me', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('reports isOwner=true for the owner', async () => {
    const res = await ctx.app.request('/api/me', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isOwner: true });
  });

  it('reports isOwner=false for a regular user', async () => {
    const res = await ctx.app.request('/api/me', { headers: bearer(ALICE) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isOwner: false });
  });
});

describe('GET /api/admin/overview', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns a zero baseline on an empty platform', async () => {
    const res = await ctx.app.request('/api/admin/overview', { headers: bearer(OWNER) });
    const body = (await res.json()) as {
      builders: { registered: number; active: number };
      agents: { total: number };
      transactions: { total: number; last24h: number };
      reasoningSpansTotal: number;
    };
    expect(body.builders).toEqual({ registered: 0, active: 0 });
    expect(body.agents.total).toBe(0);
    expect(body.transactions).toEqual({ total: 0, last24h: 0 });
    expect(body.reasoningSpansTotal).toBe(0);
  });

  it('counts registered builders (≥1 agent) and active builders (≥1 tx or span)', async () => {
    // Alice: 1 agent + tx ⇒ registered AND active.
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-a1');
    // Bob: 1 agent, no tx, no span ⇒ registered ONLY.
    await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const res = await ctx.app.request('/api/admin/overview', { headers: bearer(OWNER) });
    const body = (await res.json()) as {
      builders: { registered: number; active: number };
      agents: { total: number };
      transactions: { total: number };
    };
    expect(body.builders.registered).toBe(2);
    expect(body.builders.active).toBe(1);
    expect(body.agents.total).toBe(2);
    expect(body.transactions.total).toBe(1);
  });

  it('counts a builder active via reasoning span even with no tx', async () => {
    const bob = await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await ctx.testDb.db.insert(reasoningLogs).values({
      agentId: bob,
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      spanName: 'decide',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
    });
    const res = await ctx.app.request('/api/admin/overview', { headers: bearer(OWNER) });
    const body = (await res.json()) as { builders: { registered: number; active: number } };
    expect(body.builders).toEqual({ registered: 1, active: 1 });
  });
});

describe('GET /api/admin/milestones', () => {
  it('computes ladder progress for both builder definitions', async () => {
    const ctx = await setup([1, 2, 3]);
    try {
      // 2 registered builders, 1 active.
      const alice = await createAgent(
        ctx,
        ALICE,
        'A',
        'So11111111111111111111111111111111111111112',
      );
      await insertTx(ctx, alice, 'sig-a1');
      await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

      const res = await ctx.app.request('/api/admin/milestones', { headers: bearer(OWNER) });
      const body = (await res.json()) as {
        deadline: string;
        registered: { reachedCount: number; nextTarget: number | null };
        active: { reachedCount: number; nextTarget: number | null };
      };
      expect(body.deadline).toBe('2026-08-01');
      // registered=2 → targets 1,2 reached, next is 3.
      expect(body.registered.reachedCount).toBe(2);
      expect(body.registered.nextTarget).toBe(3);
      // active=1 → target 1 reached, next is 2.
      expect(body.active.reachedCount).toBe(1);
      expect(body.active.nextTarget).toBe(2);
    } finally {
      await ctx.testDb.close();
    }
  });
});

describe('GET /api/admin/infra', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns a well-formed snapshot that degrades gracefully', async () => {
    const res = await ctx.app.request('/api/admin/infra', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      db: { bytes: number | null; capBytes: number; usedPct: number | null };
      helius: { monitoredAgents: number; agentCeiling: number };
      ingestLagSeconds: number | null;
    };
    expect(body.db.capBytes).toBe(500 * 1024 * 1024);
    // pg_database_size may be unavailable under pglite — must be null or number, never a throw.
    expect(body.db.bytes === null || typeof body.db.bytes === 'number').toBe(true);
    expect(body.helius.agentCeiling).toBe(23);
    expect(body.helius.monitoredAgents).toBe(0);
    expect(body.ingestLagSeconds).toBeNull();
  });

  it('reports ingest lag once a tx exists', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-a1', 60_000); // 60s old
    const res = await ctx.app.request('/api/admin/infra', { headers: bearer(OWNER) });
    const body = (await res.json()) as {
      ingestLagSeconds: number | null;
      helius: { monitoredAgents: number };
    };
    expect(body.ingestLagSeconds).not.toBeNull();
    expect(body.ingestLagSeconds).toBeGreaterThanOrEqual(55);
    expect(body.helius.monitoredAgents).toBe(1);
  });
});

describe('GET /api/admin/growth + /builders + /alerts-breakdown', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('growth returns a dense daily series with cumulative builders', async () => {
    await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    const res = await ctx.app.request('/api/admin/growth?window=7d', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: string;
      points: { t: string; newBuilders: number; cumulativeBuilders: number }[];
    };
    expect(body.window).toBe('7d');
    expect(body.points.length).toBeGreaterThan(0);
    // Cumulative is monotonic non-decreasing.
    const last = body.points.at(-1);
    expect(last?.cumulativeBuilders).toBe(1);
  });

  it('builders lists per-user engagement with dormant flag', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-a1');
    await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const res = await ctx.app.request('/api/admin/builders', { headers: bearer(OWNER) });
    const body = (await res.json()) as {
      builders: { privyDid: string; agents: number; tx7d: number; dormant: boolean }[];
    };
    expect(body.builders.length).toBe(2);
    const aliceRow = body.builders.find((b) => b.privyDid === ALICE);
    const bobRow = body.builders.find((b) => b.privyDid === BOB);
    expect(aliceRow?.tx7d).toBe(1);
    expect(aliceRow?.dormant).toBe(false);
    expect(bobRow?.dormant).toBe(true);
  });

  it('alerts-breakdown pivots by rule and severity', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await ctx.testDb.db.insert(alerts).values({
      agentId: alice,
      ruleName: 'slippage_spike',
      severity: 'warning',
      dedupeKey: 'k1',
    });
    const res = await ctx.app.request('/api/admin/alerts-breakdown?window=7d', {
      headers: bearer(OWNER),
    });
    const body = (await res.json()) as {
      breakdown: { rule: string; severity: string; count: number }[];
    };
    expect(body.breakdown).toContainEqual({
      rule: 'slippage_spike',
      severity: 'warning',
      count: 1,
    });
  });
});

describe('GET /api/admin/summary', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns every panel section in a single owner-gated payload', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-a1');
    await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const res = await ctx.app.request('/api/admin/summary', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overview: {
        builders: { registered: number; active: number };
        transactions: { total: number };
      };
      milestones: { registered: { reachedCount: number } };
      growth: { points: unknown[] };
      infra: { db: { capBytes: number } };
      builders: { builders: unknown[] };
      alertsBreakdown: { window: string };
    };
    // Same numbers the individual endpoints would return — proves the
    // consolidated route shares the extracted fetchers.
    expect(body.overview.builders).toEqual({ registered: 2, active: 1 });
    expect(body.overview.transactions.total).toBe(1);
    expect(body.milestones.registered.reachedCount).toBe(0); // 2 builders < M1=4
    expect(body.growth.points.length).toBeGreaterThan(0);
    expect(body.infra.db.capBytes).toBe(500 * 1024 * 1024);
    expect(body.builders.builders.length).toBe(2);
    expect(body.alertsBreakdown.window).toBe('7d');
  });

  it('is owner-gated like the rest of /admin', async () => {
    const res = await ctx.app.request('/api/admin/summary', { headers: bearer(ALICE) });
    expect(res.status).toBe(403);
  });
});
