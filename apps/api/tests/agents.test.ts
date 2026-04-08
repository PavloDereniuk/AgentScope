/**
 * Integration tests for the agents CRUD routes (task 3.5).
 *
 * Uses a real PGlite Postgres 16 in-memory database (same migrations as
 * Supabase) + a fake auth verifier that always returns a fixed Privy
 * DID. Tests drive the Hono app end-to-end via `app.request()` — no
 * HTTP server is bound, no network touched.
 */

import { agentTransactions, agents, alerts, users } from '@agentscope/db';
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
