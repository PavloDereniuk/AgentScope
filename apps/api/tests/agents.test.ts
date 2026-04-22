/**
 * Integration tests for the agents CRUD routes (task 3.5).
 *
 * Uses a real PGlite Postgres 16 in-memory database (same migrations as
 * Supabase) + a fake auth verifier that always returns a fixed Privy
 * DID. Tests drive the Hono app end-to-end via `app.request()` — no
 * HTTP server is bound, no network touched.
 */

import { agentTransactions, agents, alerts, reasoningLogs, users } from '@agentscope/db';
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

describe('POST /api/agents', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'Test Agent',
        framework: 'elizaos',
        agentType: 'trader',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('creates an agent owned by the authenticated user', async () => {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'Trading Bot',
        framework: 'elizaos',
        agentType: 'trader',
        tags: ['eth', 'solana'],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: Record<string, unknown> };
    expect(body.agent).toMatchObject({
      name: 'Trading Bot',
      framework: 'elizaos',
      agentType: 'trader',
      walletPubkey: 'So11111111111111111111111111111111111111112',
      tags: ['eth', 'solana'],
      status: 'stale',
    });
    expect(body.agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.agent.ingestToken).toMatch(/^tok_[A-Za-z0-9_-]+$/);

    // user_id MUST come from the token, not the request body
    const userRows = await ctx.testDb.db.select().from(users).where(eq(users.privyDid, PRIVY_DID));
    expect(userRows).toHaveLength(1);
    expect(body.agent.userId).toBe(userRows[0]?.id);
  });

  it('rejects invalid body with 422 and validation message', async () => {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        // missing required fields on purpose
        name: '',
      }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it('rejects invalid walletPubkey (non-base58)', async () => {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        walletPubkey: '!!!not-a-real-pubkey!!!',
        name: 'Bad',
        framework: 'elizaos',
        agentType: 'trader',
      }),
    });
    expect(res.status).toBe(422);
  });

  it('reuses the existing users row across multiple agent creates', async () => {
    const postAgent = (name: string) =>
      ctx.app.request('/api/agents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: BEARER,
        },
        body: JSON.stringify({
          walletPubkey: 'So11111111111111111111111111111111111111112',
          name,
          framework: 'custom',
          agentType: 'other',
        }),
      });

    const r1 = await postAgent('First');
    expect(r1.status).toBe(201);

    // Same wallet + same user would violate unique (user_id, wallet_pubkey),
    // so use a different wallet the second time.
    const r2 = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        name: 'Second',
        framework: 'custom',
        agentType: 'other',
      }),
    });
    expect(r2.status).toBe(201);

    const allUsers = await ctx.testDb.db.select().from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]?.privyDid).toBe(PRIVY_DID);

    const allAgents = await ctx.testDb.db.select().from(agents);
    expect(allAgents).toHaveLength(2);
    for (const agent of allAgents) {
      expect(agent.userId).toBe(allUsers[0]?.id);
    }
  });

  it('generates a unique ingest token per agent', async () => {
    const r1 = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'A',
        framework: 'custom',
        agentType: 'other',
      }),
    });
    const r2 = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BEARER,
      },
      body: JSON.stringify({
        walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        name: 'B',
        framework: 'custom',
        agentType: 'other',
      }),
    });
    const b1 = (await r1.json()) as { agent: { ingestToken: string } };
    const b2 = (await r2.json()) as { agent: { ingestToken: string } };
    expect(b1.agent.ingestToken).not.toBe(b2.agent.ingestToken);
  });
});

describe('GET /api/agents', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  async function createAgent(body: Record<string, unknown>, token = BEARER) {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
    return (await res.json()) as { agent: { id: string; name: string } };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/agents');
    expect(res.status).toBe(401);
  });

  it('returns an empty array when the user has no agents', async () => {
    const res = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('returns all agents for the authenticated user', async () => {
    await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'First',
      framework: 'elizaos',
      agentType: 'trader',
    });
    await createAgent({
      walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      name: 'Second',
      framework: 'agent-kit',
      agentType: 'yield',
    });

    const res = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ name: string }> };
    expect(body.agents).toHaveLength(2);
    const names = body.agents.map((a) => a.name).sort();
    expect(names).toEqual(['First', 'Second']);
  });

  it('orders agents by created_at descending (newest first)', async () => {
    const first = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Oldest',
      framework: 'custom',
      agentType: 'other',
    });
    // Ensure a distinct created_at — PGlite timestamp resolution is ms.
    await new Promise((r) => setTimeout(r, 10));
    const second = await createAgent({
      walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      name: 'Newest',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { agents: Array<{ id: string; name: string }> };
    expect(body.agents[0]?.id).toBe(second.agent.id);
    expect(body.agents[1]?.id).toBe(first.agent.id);
  });

  it('scopes results to the authenticated user (no cross-tenant leak)', async () => {
    // Seed one agent as user A.
    await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Alice agent',
      framework: 'custom',
      agentType: 'other',
    });

    // Build a fresh app in the same db, but with a verifier that
    // returns a different DID.
    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    const bobRes = await bobApp.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    expect(bobRes.status).toBe(200);
    const bobBody = (await bobRes.json()) as { agents: unknown[] };
    expect(bobBody.agents).toEqual([]);

    // Alice can still see her own row.
    const aliceRes = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    const aliceBody = (await aliceRes.json()) as { agents: Array<{ name: string }> };
    expect(aliceBody.agents).toHaveLength(1);
    expect(aliceBody.agents[0]?.name).toBe('Alice agent');
  });

  it('attaches 24h aggregates to each row (task 13.3)', async () => {
    const busy = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Busy',
      framework: 'custom',
      agentType: 'other',
    });
    const quiet = await createAgent({
      walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      name: 'Quiet',
      framework: 'custom',
      agentType: 'other',
    });

    const now = new Date();
    const inside1 = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const inside2 = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
    const outside = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: busy.agent.id,
        signature: 'busy-1',
        slot: 1,
        blockTime: inside1,
        programId: '11111111111111111111111111111111',
        solDelta: '0.500000000',
        success: true,
      },
      {
        agentId: busy.agent.id,
        signature: 'busy-2',
        slot: 2,
        blockTime: inside2,
        programId: '11111111111111111111111111111111',
        solDelta: '-0.125000000',
        success: false,
      },
      {
        agentId: busy.agent.id,
        signature: 'busy-old',
        slot: 3,
        blockTime: outside,
        programId: '11111111111111111111111111111111',
        solDelta: '99.000000000',
        success: true,
      },
    ]);

    const res = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as {
      agents: Array<{
        id: string;
        recentTxCount24h: number;
        solDelta24h: string;
        successRate24h: number | null;
      }>;
    };

    const busyRow = body.agents.find((a) => a.id === busy.agent.id);
    expect(busyRow).toBeDefined();
    expect(busyRow?.recentTxCount24h).toBe(2);
    expect(Number.parseFloat(busyRow?.solDelta24h ?? '0')).toBeCloseTo(0.375, 9);
    expect(busyRow?.successRate24h).toBeCloseTo(0.5, 6);

    const quietRow = body.agents.find((a) => a.id === quiet.agent.id);
    expect(quietRow).toBeDefined();
    expect(quietRow?.recentTxCount24h).toBe(0);
    expect(quietRow?.solDelta24h).toBe('0');
    expect(quietRow?.successRate24h).toBeNull();
  });
});

describe('GET /api/agents/:id', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  async function createAgent(body: Record<string, unknown>) {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
    return (await res.json()) as { agent: { id: string; name: string } };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/agents/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid id', async () => {
    const res = await ctx.app.request('/api/agents/not-a-uuid', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown but well-formed id', async () => {
    const res = await ctx.app.request('/api/agents/11111111-1111-1111-1111-111111111111', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 (not 403) when another user owns the agent', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Alice agent',
      framework: 'custom',
      agentType: 'other',
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    const res = await bobApp.request(`/api/agents/${seeded.agent.id}`, {
      headers: { Authorization: BEARER },
    });
    // Deliberately 404, not 403 — we don't want to leak existence.
    expect(res.status).toBe(404);
  });

  it('returns the agent with zero tx and null last_alert on a fresh create', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Lonely Bot',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await ctx.app.request(`/api/agents/${seeded.agent.id}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { id: string; name: string };
      recentTxCount: number;
      lastAlert: unknown;
    };
    expect(body.agent.id).toBe(seeded.agent.id);
    expect(body.agent.name).toBe('Lonely Bot');
    expect(body.recentTxCount).toBe(0);
    expect(body.lastAlert).toBeNull();
  });

  it('counts only transactions within the 24h window', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Busy Bot',
      framework: 'custom',
      agentType: 'other',
    });

    const now = new Date();
    const insideWindow1 = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const insideWindow2 = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString();
    const insideWindow3 = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
    const outsideWindow = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    // Use partition-safe block_time values: April 2026 is covered by
    // agent_transactions_2026_04, and "now" per the test env is 2026-04-08.
    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: seeded.agent.id,
        signature: 'sig-recent-1',
        slot: 100,
        blockTime: insideWindow1,
        programId: '11111111111111111111111111111111',
        success: true,
      },
      {
        agentId: seeded.agent.id,
        signature: 'sig-recent-2',
        slot: 101,
        blockTime: insideWindow2,
        programId: '11111111111111111111111111111111',
        success: true,
      },
      {
        agentId: seeded.agent.id,
        signature: 'sig-recent-3',
        slot: 102,
        blockTime: insideWindow3,
        programId: '11111111111111111111111111111111',
        success: false,
      },
      {
        agentId: seeded.agent.id,
        signature: 'sig-old',
        slot: 10,
        blockTime: outsideWindow,
        programId: '11111111111111111111111111111111',
        success: true,
      },
    ]);

    const res = await ctx.app.request(`/api/agents/${seeded.agent.id}`, {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { recentTxCount: number };
    expect(body.recentTxCount).toBe(3);
  });

  it('returns the latest alert as last_alert', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Alerty Bot',
      framework: 'custom',
      agentType: 'other',
    });

    await ctx.testDb.db.insert(alerts).values([
      {
        agentId: seeded.agent.id,
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: { thresholdPct: 5, actualPct: 8 },
        triggeredAt: '2026-04-08T10:00:00.000Z',
      },
      {
        agentId: seeded.agent.id,
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: { thresholdMult: 3, actualMult: 6 },
        triggeredAt: '2026-04-08T12:00:00.000Z',
      },
    ]);

    const res = await ctx.app.request(`/api/agents/${seeded.agent.id}`, {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as {
      lastAlert: { ruleName: string; severity: string } | null;
    };
    expect(body.lastAlert).not.toBeNull();
    expect(body.lastAlert?.ruleName).toBe('gas_spike');
    expect(body.lastAlert?.severity).toBe('critical');
  });
});

describe('PATCH /api/agents/:id', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  async function createAgent(body: Record<string, unknown>) {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
    return (await res.json()) as {
      agent: {
        id: string;
        name: string;
        framework: string;
        walletPubkey: string;
        ingestToken: string;
      };
    };
  }

  function patch(id: string, body: unknown, token = BEARER) {
    return ctx.app.request(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/agents/11111111-1111-1111-1111-111111111111', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid id', async () => {
    const res = await ctx.app.request('/api/agents/not-a-uuid', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown but well-formed id', async () => {
    const res = await patch('11111111-1111-1111-1111-111111111111', { name: 'New' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when another user owns the agent (no existence oracle)', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Alice bot',
      framework: 'custom',
      agentType: 'other',
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    const res = await bobApp.request(`/api/agents/${seeded.agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(404);

    // Alice's row is unchanged.
    const [row] = await ctx.testDb.db.select().from(agents).where(eq(agents.id, seeded.agent.id));
    expect(row?.name).toBe('Alice bot');
  });

  it('updates a single mutable field (name) and persists to the db', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Old name',
      framework: 'custom',
      agentType: 'other',
      tags: ['keep'],
    });

    const res = await patch(seeded.agent.id, { name: 'New name' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { id: string; name: string; tags: string[] };
    };
    expect(body.agent.name).toBe('New name');
    // Untouched fields survive.
    expect(body.agent.tags).toEqual(['keep']);

    const [row] = await ctx.testDb.db.select().from(agents).where(eq(agents.id, seeded.agent.id));
    expect(row?.name).toBe('New name');
    expect(row?.tags).toEqual(['keep']);
  });

  it('updates tags, webhookUrl, and alertRules together', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Multi',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await patch(seeded.agent.id, {
      tags: ['prod', 'hot'],
      webhookUrl: 'https://example.com/hook',
      alertRules: { slippagePctThreshold: 3.5, drawdownPctThreshold: 10 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: {
        tags: string[];
        webhookUrl: string | null;
        alertRules: Record<string, unknown>;
      };
    };
    expect(body.agent.tags).toEqual(['prod', 'hot']);
    expect(body.agent.webhookUrl).toBe('https://example.com/hook');
    expect(body.agent.alertRules).toEqual({
      slippagePctThreshold: 3.5,
      drawdownPctThreshold: 10,
    });
  });

  it('allows webhookUrl to be cleared with null', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'ClearHook',
      framework: 'custom',
      agentType: 'other',
      webhookUrl: 'https://example.com/existing',
    });

    const res = await patch(seeded.agent.id, { webhookUrl: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { webhookUrl: string | null } };
    expect(body.agent.webhookUrl).toBeNull();
  });

  it('silently strips immutable fields (framework, walletPubkey, ingestToken)', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Immutable',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await patch(seeded.agent.id, {
      name: 'Renamed',
      framework: 'elizaos',
      walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      ingestToken: 'tok_hijack',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: { framework: string; walletPubkey: string; ingestToken: string; name: string };
    };
    expect(body.agent.name).toBe('Renamed');
    expect(body.agent.framework).toBe('custom');
    expect(body.agent.walletPubkey).toBe(seeded.agent.walletPubkey);
    expect(body.agent.ingestToken).toBe(seeded.agent.ingestToken);
  });

  it('accepts an empty body as a no-op and returns the current agent', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Idempotent',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await patch(seeded.agent.id, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { id: string; name: string } };
    expect(body.agent.id).toBe(seeded.agent.id);
    expect(body.agent.name).toBe('Idempotent');
  });

  it('rejects invalid webhookUrl with 422', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'BadHook',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await patch(seeded.agent.id, { webhookUrl: 'not-a-url' });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/agents/:id', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  async function createAgent(body: Record<string, unknown>) {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify(body),
    });
    if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
    return (await res.json()) as { agent: { id: string; name: string } };
  }

  function del(id: string, token = BEARER) {
    return ctx.app.request(`/api/agents/${id}`, {
      method: 'DELETE',
      headers: { Authorization: token },
    });
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/agents/11111111-1111-1111-1111-111111111111', {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid id', async () => {
    const res = await ctx.app.request('/api/agents/not-a-uuid', {
      method: 'DELETE',
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown but well-formed id', async () => {
    const res = await del('11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(404);
  });

  it('returns 404 and leaves the row intact when another user owns the agent', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Alice bot',
      framework: 'custom',
      agentType: 'other',
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    const res = await bobApp.request(`/api/agents/${seeded.agent.id}`, {
      method: 'DELETE',
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);

    const [row] = await ctx.testDb.db.select().from(agents).where(eq(agents.id, seeded.agent.id));
    expect(row).toBeDefined();
    expect(row?.name).toBe('Alice bot');
  });

  it('returns 204 with an empty body on successful delete', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Dying',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await del(seeded.agent.id);
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');

    const rows = await ctx.testDb.db.select().from(agents).where(eq(agents.id, seeded.agent.id));
    expect(rows).toHaveLength(0);
  });

  it('cascades to agent_transactions, reasoning_logs, and alerts', async () => {
    const seeded = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Parent',
      framework: 'custom',
      agentType: 'other',
    });

    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: seeded.agent.id,
      signature: 'sig-cascade-1',
      slot: 100,
      blockTime: '2026-04-08T12:00:00.000Z',
      programId: '11111111111111111111111111111111',
      success: true,
    });
    await ctx.testDb.db.insert(reasoningLogs).values({
      agentId: seeded.agent.id,
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      spanName: 'decision',
      startTime: '2026-04-08T12:00:00.000Z',
      endTime: '2026-04-08T12:00:01.000Z',
    });
    await ctx.testDb.db.insert(alerts).values({
      agentId: seeded.agent.id,
      ruleName: 'slippage_spike',
      severity: 'warning',
      payload: { thresholdPct: 5, actualPct: 8 },
    });

    const res = await del(seeded.agent.id);
    expect(res.status).toBe(204);

    const txRows = await ctx.testDb.db
      .select()
      .from(agentTransactions)
      .where(eq(agentTransactions.agentId, seeded.agent.id));
    const reasonRows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.agentId, seeded.agent.id));
    const alertRows = await ctx.testDb.db
      .select()
      .from(alerts)
      .where(eq(alerts.agentId, seeded.agent.id));

    expect(txRows).toHaveLength(0);
    expect(reasonRows).toHaveLength(0);
    expect(alertRows).toHaveLength(0);
  });

  it('does not touch other agents belonging to the same user', async () => {
    const keeper = await createAgent({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'Keeper',
      framework: 'custom',
      agentType: 'other',
    });
    const victim = await createAgent({
      walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      name: 'Victim',
      framework: 'custom',
      agentType: 'other',
    });

    const res = await del(victim.agent.id);
    expect(res.status).toBe(204);

    const survivors = await ctx.testDb.db.select().from(agents);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(keeper.agent.id);
  });
});

describe('GET /api/agents/:id/transactions', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  async function createAgent() {
    const res = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER },
      body: JSON.stringify({
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'Paginated Bot',
        framework: 'custom',
        agentType: 'other',
      }),
    });
    if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
    return (await res.json()) as { agent: { id: string } };
  }

  /**
   * Seed `count` transactions for an agent, each with a distinct
   * block_time one second apart, starting from `startIso` and moving
   * forward. Returns the signatures in insertion (chronological)
   * order so tests can assert the DESC response order.
   */
  async function seedTransactions(agentId: string, count: number, startIso: string) {
    const start = Date.parse(startIso);
    const rows = Array.from({ length: count }, (_, idx) => ({
      agentId,
      signature: `sig-${String(idx).padStart(4, '0')}`,
      slot: 1000 + idx,
      blockTime: new Date(start + idx * 1000).toISOString(),
      programId: '11111111111111111111111111111111',
      success: true,
    }));
    await ctx.testDb.db.insert(agentTransactions).values(rows);
    return rows.map((r) => r.signature);
  }

  function listTransactions(
    agentId: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const path = `/api/agents/${agentId}/transactions${qs ? `?${qs}` : ''}`;
    return ctx.app.request(path, { headers: { Authorization: BEARER } });
  }

  it('rejects unauthenticated requests with 401', async () => {
    const seeded = await createAgent();
    const res = await ctx.app.request(`/api/agents/${seeded.agent.id}/transactions`);
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid agent id', async () => {
    const res = await ctx.app.request('/api/agents/not-a-uuid/transactions', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for a limit above the cap', async () => {
    const seeded = await createAgent();
    const res = await listTransactions(seeded.agent.id, { limit: 101 });
    expect(res.status).toBe(422);
  });

  it('returns 422 for a malformed cursor', async () => {
    const seeded = await createAgent();
    const res = await listTransactions(seeded.agent.id, { cursor: '!!!not-a-cursor!!!' });
    expect(res.status).toBe(422);
  });

  it('returns 404 when the agent belongs to another user', async () => {
    const seeded = await createAgent();

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request(`/api/agents/${seeded.agent.id}/transactions`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  it('returns an empty list and null cursor for an agent with no transactions', async () => {
    const seeded = await createAgent();
    const res = await listTransactions(seeded.agent.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[]; nextCursor: string | null };
    expect(body.transactions).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('orders transactions newest first (DESC by block_time)', async () => {
    const seeded = await createAgent();
    const sigs = await seedTransactions(seeded.agent.id, 5, '2026-04-07T12:00:00.000Z');

    const res = await listTransactions(seeded.agent.id);
    const body = (await res.json()) as {
      transactions: Array<{ signature: string }>;
      nextCursor: string | null;
    };
    expect(body.transactions).toHaveLength(5);
    // Seeded in chronological order; response should be reversed.
    const expected = [...sigs].reverse();
    expect(body.transactions.map((t) => t.signature)).toEqual(expected);
    expect(body.nextCursor).toBeNull();
  });

  it('paginates 150 rows across 2 pages of limit=100 with a valid cursor', async () => {
    const seeded = await createAgent();
    const sigs = await seedTransactions(seeded.agent.id, 150, '2026-04-07T00:00:00.000Z');
    const expected = [...sigs].reverse(); // DESC order

    const page1Res = await listTransactions(seeded.agent.id, { limit: 100 });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      transactions: Array<{ signature: string }>;
      nextCursor: string | null;
    };
    expect(page1.transactions).toHaveLength(100);
    expect(page1.transactions.map((t) => t.signature)).toEqual(expected.slice(0, 100));
    expect(page1.nextCursor).not.toBeNull();
    expect(typeof page1.nextCursor).toBe('string');

    const page2Res = await listTransactions(seeded.agent.id, {
      limit: 100,
      cursor: page1.nextCursor ?? '',
    });
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      transactions: Array<{ signature: string }>;
      nextCursor: string | null;
    };
    expect(page2.transactions).toHaveLength(50);
    expect(page2.transactions.map((t) => t.signature)).toEqual(expected.slice(100));
    expect(page2.nextCursor).toBeNull();
  });

  it('filters by from/to time window', async () => {
    const seeded = await createAgent();
    // 10 tx spaced 1 hour apart starting 2026-04-08T00:00:00Z.
    const start = Date.parse('2026-04-08T00:00:00.000Z');
    const rows = Array.from({ length: 10 }, (_, i) => ({
      agentId: seeded.agent.id,
      signature: `sig-hr-${i}`,
      slot: 2000 + i,
      blockTime: new Date(start + i * 60 * 60 * 1000).toISOString(),
      programId: '11111111111111111111111111111111',
      success: true,
    }));
    await ctx.testDb.db.insert(agentTransactions).values(rows);

    // Request a window covering hours 3..6 inclusive → 4 rows.
    const res = await listTransactions(seeded.agent.id, {
      from: '2026-04-08T03:00:00.000Z',
      to: '2026-04-08T06:00:00.000Z',
    });
    const body = (await res.json()) as {
      transactions: Array<{ signature: string }>;
    };
    expect(body.transactions.map((t) => t.signature).sort()).toEqual([
      'sig-hr-3',
      'sig-hr-4',
      'sig-hr-5',
      'sig-hr-6',
    ]);
  });
});
