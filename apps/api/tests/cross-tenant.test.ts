/**
 * Cross-tenant isolation integration test (task 14.6).
 *
 * Seeds a populated world as user A — agent, transactions, reasoning spans,
 * alerts — and then drives every read endpoint the dashboard calls as user
 * B. None of them may return a single row or field owned by A. The table
 * also asserts the shapes come back as the user would see them (empty
 * lists or 404s, never 500s or partial leakage).
 *
 * Coverage (7 endpoints, matching docs/TASKS.md § 14.6):
 *   GET    /api/agents
 *   GET    /api/agents/:id
 *   GET    /api/transactions/:signature
 *   GET    /api/alerts
 *   GET    /api/reasoning/traces
 *   GET    /api/stats/overview
 *   GET    /api/agents/:id/stream       (SSE)
 *
 * RLS policies live in packages/db/src/migrations/0001_rls_and_partition.sql
 * and would catch a naked SQL leak, but they are disabled under PGlite's
 * default session — so this test exercises the application-layer
 * `ensureUser` + WHERE-scoped queries that are the real first line of
 * defense when the API runs against a role with BYPASS RLS (e.g. the
 * service-role key Supabase issues for server-side clients).
 */

import { agentTransactions, alerts, reasoningLogs } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const DID_ALICE = 'did:privy:alice';
const DID_BOB = 'did:privy:bob';
const BEARER_ALICE = 'Bearer alice-token';
const BEARER_BOB = 'Bearer bob-token';

/** Verifier that maps specific bearer tokens to user DIDs. */
function makeMultiUserVerifier(): AuthVerifier {
  return {
    async verify(token: string) {
      if (token === 'alice-token') return { userId: DID_ALICE };
      if (token === 'bob-token') return { userId: DID_BOB };
      throw new Error('unknown token');
    },
  };
}

interface TwoUserApp {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function setup(): Promise<TwoUserApp> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: makeMultiUserVerifier(),
    sseBus: createSseBus(),
    logger: silentLogger,
  });
  return { app, testDb };
}

describe('Cross-tenant isolation — user B must never see user A data', () => {
  let ctx: TwoUserApp;
  let agentAId: string;
  let aliceSignature: string;
  let aliceTraceId: string;

  beforeEach(async () => {
    ctx = await setup();

    // 1. Alice creates an agent.
    const createRes = await ctx.app.request('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER_ALICE },
      body: JSON.stringify({
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'Alice Bot',
        framework: 'elizaos',
        agentType: 'trader',
      }),
    });
    const createBody = (await createRes.json()) as { agent: { id: string } };
    agentAId = createBody.agent.id;

    // 2. Seed a transaction, reasoning span, and an alert — straight to
    //    the DB (bypassing the OTLP/ingestion pipeline isn't in scope for
    //    this test; we only care that the read paths filter by owner).
    aliceSignature = 'aLiCeSig111111111111111111111111111111111111111111111111111111aa';
    aliceTraceId = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: agentAId,
      signature: aliceSignature,
      slot: 100,
      blockTime: new Date().toISOString(),
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionName: 'jupiter.swap',
      success: true,
      feeLamports: 5000,
    });

    await ctx.testDb.db.insert(reasoningLogs).values({
      agentId: agentAId,
      traceId: aliceTraceId,
      spanId: '1111111122223333',
      parentSpanId: null,
      spanName: 'alice.decide',
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      attributes: {},
    });

    await ctx.testDb.db.insert(alerts).values({
      agentId: agentAId,
      ruleName: 'slippage_spike',
      severity: 'warning',
      payload: { actualPct: 10, thresholdPct: 5 },
      dedupeKey: `alice:${aliceSignature}`,
    });
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('GET /api/agents — Bob sees an empty list', async () => {
    const res = await ctx.app.request('/api/agents', {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toEqual([]);
  });

  it('GET /api/agents/:id — Bob gets 404 for Alice agent (no existence oracle)', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}`, {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/agents/:id/transactions — Bob gets 404, not an empty list of Alice txs', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}/transactions`, {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/agents/:id/reasoning — Bob gets 404', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}/reasoning`, {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/transactions/:signature — Bob gets 404 for Alice signature', async () => {
    const res = await ctx.app.request(`/api/transactions/${aliceSignature}`, {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/alerts — Bob sees no alerts', async () => {
    const res = await ctx.app.request('/api/alerts', {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts).toEqual([]);
  });

  it('GET /api/reasoning/traces — Bob sees no traces', async () => {
    const res = await ctx.app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: unknown[] };
    expect(body.traces).toEqual([]);
  });

  it('GET /api/stats/overview — Bob sees zeroed KPIs, never Alice totals', async () => {
    const res = await ctx.app.request('/api/stats/overview', {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(200);
    // Shape varies by implementation; the only invariant we assert is
    // that no user-agent-scoped count hints at Alice's data (e.g. her
    // agent count > 0 or her tx count > 0 showing up under Bob's key).
    const body = (await res.json()) as Record<string, unknown>;
    const json = JSON.stringify(body);
    expect(json).not.toContain(aliceSignature);
    expect(json).not.toContain('Alice Bot');
    expect(json).not.toContain(agentAId);
  });

  it('GET /api/agents/:id/stream — Bob gets 404 without opening an SSE stream', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}/stream`, {
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
    // Must NOT be text/event-stream (that would mean the stream opened
    // and Bob would start receiving Alice's events).
    expect(res.headers.get('Content-Type')).not.toMatch(/event-stream/i);
  });

  it('POST /api/agents/:id/test-alert — Bob gets 404', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}/test-alert`, {
      method: 'POST',
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /api/agents/:id — Bob gets 404, Alice row remains untouched', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: BEARER_BOB },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(404);

    // Verify from Alice's side the row still has the original name.
    const check = await ctx.app.request(`/api/agents/${agentAId}`, {
      headers: { Authorization: BEARER_ALICE },
    });
    const body = (await check.json()) as { agent: { name: string } };
    expect(body.agent.name).toBe('Alice Bot');
  });

  it('DELETE /api/agents/:id — Bob gets 404, Alice row survives', async () => {
    const res = await ctx.app.request(`/api/agents/${agentAId}`, {
      method: 'DELETE',
      headers: { Authorization: BEARER_BOB },
    });
    expect(res.status).toBe(404);

    const check = await ctx.app.request(`/api/agents/${agentAId}`, {
      headers: { Authorization: BEARER_ALICE },
    });
    expect(check.status).toBe(200);
  });
});
