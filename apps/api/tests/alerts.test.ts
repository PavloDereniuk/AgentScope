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

function setFeedback(ctx: TestApp, alertId: string, body: unknown, token = BEARER) {
  return ctx.app.request(`/api/alerts/${alertId}/feedback`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body),
  });
}

async function seedAlert(
  ctx: TestApp,
  agentId: string,
  ruleName: 'gas_spike' | 'drawdown' = 'gas_spike',
  triggeredAt: string = new Date().toISOString(),
): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(alerts)
    .values({ agentId, ruleName, severity: 'warning', payload: {}, triggeredAt })
    .returning({ id: alerts.id });
  if (!row) throw new Error('seed alert failed');
  return row.id;
}

function bobApp(ctx: TestApp) {
  return buildApp({
    db: ctx.testDb.db,
    verifier: makeVerifier('did:privy:user-bob'),
    sseBus: createSseBus(),
    logger: silentLogger,
  });
}

const WALLET = 'So11111111111111111111111111111111111111112';

describe('PATCH /api/alerts/:id/feedback', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('labels an alert and surfaces the label in the feed', async () => {
    const agent = await createAgent(ctx, 'Bot', WALLET);
    const alertId = await seedAlert(ctx, agent.id);

    const res = await setFeedback(ctx, alertId, { feedback: 'noise' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alert: { id: string; feedback: string; feedbackAt: string | null };
    };
    expect(body.alert.id).toBe(alertId);
    expect(body.alert.feedback).toBe('noise');
    expect(body.alert.feedbackAt).not.toBeNull();

    const list = (await (await listAlerts(ctx)).json()) as {
      alerts: Array<{ id: string; feedback: string | null }>;
    };
    expect(list.alerts[0]?.feedback).toBe('noise');
  });

  it('clears the label with null', async () => {
    const agent = await createAgent(ctx, 'Bot', WALLET);
    const alertId = await seedAlert(ctx, agent.id);
    await setFeedback(ctx, alertId, { feedback: 'useful' });

    const res = await setFeedback(ctx, alertId, { feedback: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alert: { feedback: string | null; feedbackAt: string | null };
    };
    expect(body.alert.feedback).toBeNull();
    expect(body.alert.feedbackAt).toBeNull();
  });

  it('returns 422 for an unknown label or a missing field', async () => {
    const agent = await createAgent(ctx, 'Bot', WALLET);
    const alertId = await seedAlert(ctx, agent.id);
    expect((await setFeedback(ctx, alertId, { feedback: 'meh' })).status).toBe(422);
    expect((await setFeedback(ctx, alertId, {})).status).toBe(422);
  });

  it('returns 422 for a non-uuid alert id', async () => {
    const res = await setFeedback(ctx, 'not-a-uuid', { feedback: 'noise' });
    expect(res.status).toBe(422);
  });

  it("returns 404 for another user's alert and leaves it untouched", async () => {
    const agent = await createAgent(ctx, 'Alice bot', WALLET);
    const alertId = await seedAlert(ctx, agent.id);

    const res = await bobApp(ctx).request(`/api/alerts/${alertId}/feedback`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify({ feedback: 'noise' }),
    });
    expect(res.status).toBe(404);

    const list = (await (await listAlerts(ctx)).json()) as {
      alerts: Array<{ feedback: string | null }>;
    };
    expect(list.alerts[0]?.feedback).toBeNull();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/alerts/00000000-0000-4000-8000-000000000000/feedback', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'noise' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/alerts/feedback-stats', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rolls labels up per rule inside the window', async () => {
    const agent = await createAgent(ctx, 'Bot', WALLET);
    const g1 = await seedAlert(ctx, agent.id, 'gas_spike');
    const g2 = await seedAlert(ctx, agent.id, 'gas_spike');
    await seedAlert(ctx, agent.id, 'gas_spike');
    const d1 = await seedAlert(ctx, agent.id, 'drawdown');
    // Outside the 30-day window — must not count.
    await seedAlert(ctx, agent.id, 'drawdown', '2020-01-01T00:00:00.000Z');
    await setFeedback(ctx, g1, { feedback: 'noise' });
    await setFeedback(ctx, g2, { feedback: 'useful' });
    await setFeedback(ctx, d1, { feedback: 'noise' });

    const res = await ctx.app.request(`/api/alerts/feedback-stats?agentId=${agent.id}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowDays: number; rules: unknown[] };
    expect(body.windowDays).toBe(30);
    // Ordered by the pg enum's declaration order, not alphabetically.
    expect(body.rules).toEqual([
      { ruleName: 'gas_spike', total: 3, useful: 1, noise: 1 },
      { ruleName: 'drawdown', total: 1, useful: 0, noise: 1 },
    ]);
  });

  it("returns 404 for another user's agent", async () => {
    const agent = await createAgent(ctx, 'Alice bot', WALLET);
    const res = await bobApp(ctx).request(`/api/alerts/feedback-stats?agentId=${agent.id}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 without an agentId', async () => {
    const res = await ctx.app.request('/api/alerts/feedback-stats', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });
});
