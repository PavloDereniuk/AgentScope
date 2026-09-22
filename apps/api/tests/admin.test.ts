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
import { getMilestoneExport } from '../src/routes/admin';
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

describe('GET /api/admin/builders + /alerts-breakdown', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
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
      infra: { db: { capBytes: number } };
      builders: { builders: unknown[] };
      alertsBreakdown: { window: string };
    };
    // Same numbers the individual endpoints would return — proves the
    // consolidated route shares the extracted fetchers.
    expect(body.overview.builders).toEqual({ registered: 2, active: 1 });
    expect(body.overview.transactions.total).toBe(1);
    expect(body.milestones.registered.reachedCount).toBe(0); // 2 builders < M1=4
    expect(body.infra.db.capBytes).toBe(500 * 1024 * 1024);
    expect(body.builders.builders.length).toBe(2);
    expect(body.alertsBreakdown.window).toBe('7d');
  });

  it('is owner-gated like the rest of /admin', async () => {
    const res = await ctx.app.request('/api/admin/summary', { headers: bearer(ALICE) });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/milestone-export', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await ctx.testDb.close();
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  interface ExportBuilder {
    builderHash: string;
    registeredAt: string;
    agentsCount: number;
    firstTxAt: string | null;
    lastTxAt: string | null;
    tx14d: number;
    alertsDelivered30d: number;
    lastAlertDeliveredAt: string | null;
    lastActiveAt: string | null;
    connected: boolean;
    active: boolean;
  }
  interface ExportBody {
    generatedAt: string;
    definition: { txWindowDays: number; alertWindowDays: number };
    excluded: { ownerUsers: number };
    counts: { registered: number; connected: number; active: number };
    builders: ExportBuilder[];
  }

  async function fetchExport(): Promise<ExportBody> {
    const res = await ctx.app.request('/api/admin/milestone-export', { headers: bearer(OWNER) });
    expect(res.status).toBe(200);
    return (await res.json()) as ExportBody;
  }

  async function insertAlert(
    agentId: string,
    status: 'delivered' | 'failed' | 'pending',
    ageMs: number,
  ) {
    const at = new Date(Date.now() - ageMs).toISOString();
    await ctx.testDb.db.insert(alerts).values({
      agentId,
      ruleName: 'slippage_spike',
      severity: 'warning',
      triggeredAt: at,
      deliveredAt: status === 'delivered' ? at : null,
      deliveryStatus: status,
    });
  }

  it('is owner-gated', async () => {
    const res = await ctx.app.request('/api/admin/milestone-export', { headers: bearer(ALICE) });
    expect(res.status).toBe(403);
  });

  it('returns a zero baseline with the grant definition spelled out', async () => {
    const body = await fetchExport();
    expect(body.definition).toEqual({ txWindowDays: 14, alertWindowDays: 30 });
    expect(body.counts).toEqual({ registered: 0, connected: 0, active: 0 });
    expect(body.builders).toEqual([]);
    expect(body.excluded.ownerUsers).toBe(0);
  });

  it('excludes owner-owned agents from every row and count', async () => {
    const mine = await createAgent(ctx, OWNER, 'Me', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, mine, 'sig-owner');
    await createAgent(ctx, ALICE, 'A', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const body = await fetchExport();
    expect(body.excluded.ownerUsers).toBe(1);
    expect(body.counts).toEqual({ registered: 1, connected: 0, active: 0 });
    expect(body.builders.length).toBe(1);
  });

  it('marks a builder connected (M1) on any tx ever, active (M2/M3) only inside 14d', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-old', 20 * DAY_MS);
    const bob = await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await insertTx(ctx, bob, 'sig-fresh', 1 * DAY_MS);

    const body = await fetchExport();
    expect(body.counts).toEqual({ registered: 2, connected: 2, active: 1 });
    const [first, second] = body.builders;
    // Active builders sort first so the screenshot leads with the proof.
    expect(first?.active).toBe(true);
    expect(first?.tx14d).toBe(1);
    expect(first?.lastActiveAt).toBe(first?.lastTxAt);
    expect(second?.active).toBe(false);
    expect(second?.connected).toBe(true);
    expect(second?.tx14d).toBe(0);
    expect(second?.firstTxAt).not.toBeNull();
  });

  it('marks a builder active via a delivered alert inside 30d, not via failed/pending ones', async () => {
    const alice = await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    await insertTx(ctx, alice, 'sig-old-a', 40 * DAY_MS);
    await insertAlert(alice, 'delivered', 10 * DAY_MS);
    const bob = await createAgent(ctx, BOB, 'B', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await insertTx(ctx, bob, 'sig-old-b', 40 * DAY_MS);
    await insertAlert(bob, 'failed', 1 * DAY_MS);
    await insertAlert(bob, 'pending', 1 * DAY_MS);
    await insertAlert(bob, 'delivered', 45 * DAY_MS);

    const body = await fetchExport();
    expect(body.counts).toEqual({ registered: 2, connected: 2, active: 1 });
    const aliceRow = body.builders.find((b) => b.active);
    const bobRow = body.builders.find((b) => !b.active);
    expect(aliceRow?.alertsDelivered30d).toBe(1);
    expect(aliceRow?.lastActiveAt).toBe(aliceRow?.lastAlertDeliveredAt);
    expect(bobRow?.alertsDelivered30d).toBe(0);
    expect(bobRow?.lastAlertDeliveredAt).not.toBeNull(); // the 45d one, outside the window
  });

  it('aggregates every agent of a builder into one row', async () => {
    const a1 = await createAgent(ctx, ALICE, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, ALICE, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await insertTx(ctx, a1, 'sig-1', 2 * DAY_MS);
    await insertTx(ctx, a2, 'sig-2', 1 * DAY_MS);
    await insertTx(ctx, a2, 'sig-3', 30 * DAY_MS);

    const body = await fetchExport();
    expect(body.builders.length).toBe(1);
    const row = body.builders[0];
    expect(row?.agentsCount).toBe(2);
    expect(row?.tx14d).toBe(2);
    expect(row?.firstTxAt).not.toBe(row?.lastTxAt);
  });

  it('excludes nobody when the owner allowlist is empty', async () => {
    // An owner-less deployment cannot reach /admin at all, so the fetcher is
    // exercised directly: an empty set must mean "no exclusions", not the
    // `not in (null)` trap that would exclude everyone.
    await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    const body = await getMilestoneExport(ctx.testDb.db, new Set());
    expect(body.counts.registered).toBe(1);
    expect(body.excluded.ownerUsers).toBe(0);
  });

  it('carries no PII — hashes are stable, short, and never the DID or email', async () => {
    await createAgent(ctx, ALICE, 'A', 'So11111111111111111111111111111111111111112');
    const first = await fetchExport();
    const second = await fetchExport();
    const row = first.builders[0];
    expect(row?.builderHash).toMatch(/^[0-9a-f]{12}$/);
    expect(row?.builderHash).toBe(second.builders[0]?.builderHash);
    expect(Object.keys(row ?? {})).not.toContain('privyDid');
    expect(Object.keys(row ?? {})).not.toContain('email');
    expect(Object.keys(row ?? {})).not.toContain('userId');
    expect(JSON.stringify(first)).not.toContain(ALICE);
  });
});
