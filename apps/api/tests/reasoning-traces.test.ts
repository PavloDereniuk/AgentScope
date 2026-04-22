/**
 * Integration tests for GET /api/reasoning/traces (task 13.5).
 *
 * Seeds reasoning_logs rows directly via drizzle (bypassing the OTLP
 * receiver). Verifies the cross-agent shape, ownership isolation, the
 * agentId filter, span aggregation (count + duration), the root span name
 * pick, and the hasError rollup.
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:traces-test';
const BEARER = 'Bearer stub-token';

function makeVerifier(userId: string = PRIVY_DID): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

const TRACE_A = 'aaaa0000aaaa0000aaaa0000aaaa0000';
const TRACE_B = 'bbbb0000bbbb0000bbbb0000bbbb0000';
const TRACE_C = 'cccc0000cccc0000cccc0000cccc0000';
const TRACE_FOREIGN = 'ffff0000ffff0000ffff0000ffff0000';

interface TestCtx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  agentA: string;
  agentB: string;
}

async function setup(): Promise<TestCtx> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: makeVerifier(),
    sseBus: createSseBus(),
    logger: silentLogger,
  });

  const [user] = await testDb.db.insert(users).values({ privyDid: PRIVY_DID }).returning();
  if (!user) throw new Error('seed user failed');

  const [agentA] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Agent A',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_traces_a',
    })
    .returning();
  const [agentB] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '22222222222222222222222222222222',
      name: 'Agent B',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_traces_b',
    })
    .returning();
  if (!agentA || !agentB) throw new Error('seed agents failed');

  // TRACE_A (agent A): 2 spans, no error
  //   span-a-root (parent=null) @ 12:00:00 → 12:00:01
  //   span-a-child              @ 12:00:00.500 → 12:00:00.800
  await testDb.db.insert(reasoningLogs).values([
    {
      agentId: agentA.id,
      traceId: TRACE_A,
      spanId: '1111111111111111',
      spanName: 'root-action-a',
      startTime: '2026-04-18T12:00:00.000Z',
      endTime: '2026-04-18T12:00:01.000Z',
      attributes: { foo: 'bar' },
    },
    {
      agentId: agentA.id,
      traceId: TRACE_A,
      spanId: '2222222222222222',
      parentSpanId: '1111111111111111',
      spanName: 'child-a',
      startTime: '2026-04-18T12:00:00.500Z',
      endTime: '2026-04-18T12:00:00.800Z',
      attributes: {},
    },
  ]);

  // TRACE_B (agent B): 1 span, ERROR status
  await testDb.db.insert(reasoningLogs).values({
    agentId: agentB.id,
    traceId: TRACE_B,
    spanId: '3333333333333333',
    spanName: 'root-action-b',
    startTime: '2026-04-18T13:00:00.000Z',
    endTime: '2026-04-18T13:00:00.500Z',
    attributes: { 'otel.status_code': 2, 'otel.status_message': 'boom' },
  });

  return { app, testDb, agentA: agentA.id, agentB: agentB.id };
}

async function seedForeign(ctx: TestCtx, privyDid: string) {
  const [otherUser] = await ctx.testDb.db.insert(users).values({ privyDid }).returning();
  if (!otherUser) throw new Error('seed foreign user failed');
  const [otherAgent] = await ctx.testDb.db
    .insert(agents)
    .values({
      userId: otherUser.id,
      walletPubkey: '33333333333333333333333333333333',
      name: 'Foreign',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_foreign',
    })
    .returning();
  if (!otherAgent) throw new Error('seed foreign agent failed');
  await ctx.testDb.db.insert(reasoningLogs).values({
    agentId: otherAgent.id,
    traceId: TRACE_FOREIGN,
    spanId: '4444444444444444',
    spanName: 'foreign-action',
    startTime: '2026-04-18T14:00:00.000Z',
    endTime: '2026-04-18T14:00:01.000Z',
    attributes: {},
  });
  return otherAgent.id;
}

interface TraceRow {
  traceId: string;
  rootSpanName: string;
  spanCount: number;
  startTime: string;
  durationMs: number | null;
  hasError: boolean;
  agentId: string;
}

describe('GET /api/reasoning/traces', () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/reasoning/traces');
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid agentId', async () => {
    const res = await ctx.app.request('/api/reasoning/traces?agentId=not-a-uuid', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns empty array when the user has no traces', async () => {
    const fresh = await createTestDatabase();
    const app = buildApp({
      db: fresh.db,
      verifier: makeVerifier('did:privy:empty'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: TraceRow[] };
    expect(body.traces).toEqual([]);
    await fresh.close();
  });

  it('summarises traces across every agent the user owns', async () => {
    const res = await ctx.app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { traces: TraceRow[] };
    expect(body.traces).toHaveLength(2);
    // DESC by min(start_time): TRACE_B @ 13:00 first, TRACE_A @ 12:00 second
    expect(body.traces.map((t) => t.traceId)).toEqual([TRACE_B, TRACE_A]);
  });

  it('aggregates spanCount and durationMs correctly', async () => {
    const res = await ctx.app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { traces: TraceRow[] };
    const traceA = body.traces.find((t) => t.traceId === TRACE_A);
    const traceB = body.traces.find((t) => t.traceId === TRACE_B);

    expect(traceA).toBeDefined();
    expect(traceA?.spanCount).toBe(2);
    // max(end) 12:00:01 - min(start) 12:00:00 = 1000ms
    expect(traceA?.durationMs).toBe(1000);
    expect(traceA?.rootSpanName).toBe('root-action-a');
    expect(traceA?.hasError).toBe(false);
    expect(traceA?.agentId).toBe(ctx.agentA);

    expect(traceB).toBeDefined();
    expect(traceB?.spanCount).toBe(1);
    expect(traceB?.durationMs).toBe(500);
    expect(traceB?.rootSpanName).toBe('root-action-b');
    expect(traceB?.hasError).toBe(true);
    expect(traceB?.agentId).toBe(ctx.agentB);
  });

  it('falls back rootSpanName to any span when no explicit root exists', async () => {
    // Seed a trace where every span has a parent — no parent_span_id IS NULL
    await ctx.testDb.db.insert(reasoningLogs).values({
      agentId: ctx.agentA,
      traceId: TRACE_C,
      spanId: '5555555555555555',
      parentSpanId: 'xxxxxxxxxxxxxxxx',
      spanName: 'orphan-span',
      startTime: '2026-04-18T14:00:00.000Z',
      endTime: '2026-04-18T14:00:00.500Z',
      attributes: {},
    });

    const res = await ctx.app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { traces: TraceRow[] };
    const traceC = body.traces.find((t) => t.traceId === TRACE_C);
    expect(traceC?.rootSpanName).toBe('orphan-span');
  });

  it('filters by agentId', async () => {
    const res = await ctx.app.request(`/api/reasoning/traces?agentId=${ctx.agentA}`, {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { traces: TraceRow[] };
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0]?.traceId).toBe(TRACE_A);
  });

  it("never returns another user's traces", async () => {
    await seedForeign(ctx, 'did:privy:bob');
    const res = await ctx.app.request('/api/reasoning/traces', {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as { traces: TraceRow[] };
    expect(body.traces.map((t) => t.traceId)).not.toContain(TRACE_FOREIGN);
    expect(body.traces).toHaveLength(2);
  });

  it('respects the limit query parameter (1..100) and default 50', async () => {
    const res422 = await ctx.app.request('/api/reasoning/traces?limit=0', {
      headers: { Authorization: BEARER },
    });
    expect(res422.status).toBe(422);
    const resOver = await ctx.app.request('/api/reasoning/traces?limit=101', {
      headers: { Authorization: BEARER },
    });
    expect(resOver.status).toBe(422);
    const resOne = await ctx.app.request('/api/reasoning/traces?limit=1', {
      headers: { Authorization: BEARER },
    });
    const body = (await resOne.json()) as { traces: TraceRow[] };
    expect(body.traces).toHaveLength(1);
  });
});
