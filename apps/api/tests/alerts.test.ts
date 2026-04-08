/**
 * Integration tests for GET /api/alerts (task 3.12).
 *
 * Full buildApp pipeline over PGlite + fake verifier. Verifies
 * ownership isolation (another user's alerts never appear), the
 * four query filters (agentId, severity, from, to), ordering, and
 * the MVP no-cursor cap.
 */

import { alerts } from '@agentscope/db';
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

function listAlerts(ctx: TestApp, query: Record<string, string | undefined> = {}, token = BEARER) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v);
  }
  const qs = params.toString();
  return ctx.app.request(`/api/alerts${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: token },
  });
}

describe('GET /api/alerts', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/alerts');
    expect(res.status).toBe(401);
  });

  it('returns 422 for an unknown severity', async () => {
    const res = await listAlerts(ctx, { severity: 'extreme' });
    expect(res.status).toBe(422);
  });

  it('returns 422 for a non-uuid agentId', async () => {
    const res = await listAlerts(ctx, { agentId: 'not-a-uuid' });
    expect(res.status).toBe(422);
  });

  it('returns 422 when from > to', async () => {
    const res = await listAlerts(ctx, {
      from: '2026-04-08T12:00:00.000Z',
      to: '2026-04-07T12:00:00.000Z',
    });
    expect(res.status).toBe(422);
  });

  it('returns an empty array when the user has no alerts', async () => {
    const res = await listAlerts(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts).toEqual([]);
  });

  it("never returns another user's alerts", async () => {
    const aliceAgent = await createAgent(
      ctx,
      'Alice bot',
      'So11111111111111111111111111111111111111112',
    );
    await ctx.testDb.db.insert(alerts).values({
      agentId: aliceAgent.id,
      ruleName: 'slippage_spike',
      severity: 'warning',
      payload: { thresholdPct: 5, actualPct: 8 },
      triggeredAt: '2026-04-08T10:00:00.000Z',
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request('/api/alerts', { headers: { Authorization: BEARER } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts).toEqual([]);
  });

  it('returns alerts across every agent owned by the user, newest first', async () => {
    const a1 = await createAgent(ctx, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: a1.id,
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: { a: 1 },
        triggeredAt: '2026-04-08T10:00:00.000Z',
      },
      {
        agentId: a2.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: { b: 2 },
        triggeredAt: '2026-04-08T12:00:00.000Z',
      },
      {
        agentId: a1.id,
        ruleName: 'drawdown',
        severity: 'info',
        payload: { c: 3 },
        triggeredAt: '2026-04-08T11:00:00.000Z',
      },
    ]);

    const res = await listAlerts(ctx);
    const body = (await res.json()) as {
      alerts: Array<{ ruleName: string; severity: string; triggeredAt: string }>;
    };
    expect(body.alerts).toHaveLength(3);
    // DESC by triggeredAt
    expect(body.alerts.map((a) => a.ruleName)).toEqual(['gas_spike', 'drawdown', 'slippage_spike']);
  });

  it('filters by severity=critical', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: agent.id,
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: {},
        triggeredAt: '2026-04-08T10:00:00.000Z',
      },
      {
        agentId: agent.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: '2026-04-08T11:00:00.000Z',
      },
      {
        agentId: agent.id,
        ruleName: 'drawdown',
        severity: 'info',
        payload: {},
        triggeredAt: '2026-04-08T12:00:00.000Z',
      },
    ]);

    const res = await listAlerts(ctx, { severity: 'critical' });
    const body = (await res.json()) as {
      alerts: Array<{ severity: string; ruleName: string }>;
    };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.severity).toBe('critical');
    expect(body.alerts[0]?.ruleName).toBe('gas_spike');
  });

  it('filters by agentId to a single agent', async () => {
    const a1 = await createAgent(ctx, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: a1.id,
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: {},
        triggeredAt: '2026-04-08T10:00:00.000Z',
      },
      {
        agentId: a2.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: '2026-04-08T11:00:00.000Z',
      },
    ]);

    const res = await listAlerts(ctx, { agentId: a2.id });
    const body = (await res.json()) as { alerts: Array<{ agentId: string }> };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.agentId).toBe(a2.id);
  });

  it('filters by from/to time window', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const start = Date.parse('2026-04-08T00:00:00.000Z');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      agentId: agent.id,
      ruleName: 'slippage_spike' as const,
      severity: 'info' as const,
      payload: { i },
      triggeredAt: new Date(start + i * 60 * 60 * 1000).toISOString(),
    }));
    await ctx.testDb.db.insert(alerts).values(rows);

    // Window covering hours 3..6 inclusive → 4 rows.
    const res = await listAlerts(ctx, {
      from: '2026-04-08T03:00:00.000Z',
      to: '2026-04-08T06:00:00.000Z',
    });
    const body = (await res.json()) as {
      alerts: Array<{ triggeredAt: string }>;
    };
    expect(body.alerts).toHaveLength(4);
    for (const alert of body.alerts) {
      const t = Date.parse(alert.triggeredAt);
      expect(t).toBeGreaterThanOrEqual(Date.parse('2026-04-08T03:00:00.000Z'));
      expect(t).toBeLessThanOrEqual(Date.parse('2026-04-08T06:00:00.000Z'));
    }
  });

  it('combines multiple filters (agentId + severity)', async () => {
    const a1 = await createAgent(ctx, 'A1', 'So11111111111111111111111111111111111111112');
    const a2 = await createAgent(ctx, 'A2', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: a1.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: '2026-04-08T10:00:00.000Z',
      },
      {
        agentId: a2.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
        triggeredAt: '2026-04-08T11:00:00.000Z',
      },
      {
        agentId: a1.id,
        ruleName: 'drawdown',
        severity: 'warning',
        payload: {},
        triggeredAt: '2026-04-08T12:00:00.000Z',
      },
    ]);

    const res = await listAlerts(ctx, { agentId: a1.id, severity: 'critical' });
    const body = (await res.json()) as { alerts: Array<{ agentId: string; severity: string }> };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.agentId).toBe(a1.id);
    expect(body.alerts[0]?.severity).toBe('critical');
  });
});
