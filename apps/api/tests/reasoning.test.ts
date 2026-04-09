/**
 * Integration tests for GET /api/agents/:id/reasoning (task 4.6).
 *
 * Seeds reasoning_logs rows directly via drizzle (bypassing the OTLP
 * receiver) so tests focus on the read path: ownership check, optional
 * traceId filter, ordering, and response shape.
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:reasoning-test-user';
const BEARER = 'Bearer stub-token';

function makeVerifier(userId: string = PRIVY_DID): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

interface TestCtx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  agentId: string;
}

const TRACE_A = 'aaaa0000aaaa0000aaaa0000aaaa0000';
const TRACE_B = 'bbbb0000bbbb0000bbbb0000bbbb0000';

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

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Reasoning Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_reasoning_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');

  // Seed 3 spans across 2 traces
  await testDb.db.insert(reasoningLogs).values([
    {
      agentId: agent.id,
      traceId: TRACE_A,
      spanId: '1111111111111111',
      spanName: 'span-a1',
      startTime: '2024-04-08T12:00:00.000Z',
      endTime: '2024-04-08T12:00:01.000Z',
      attributes: { foo: 'bar' },
    },
    {
      agentId: agent.id,
      traceId: TRACE_A,
      spanId: '2222222222222222',
      parentSpanId: '1111111111111111',
      spanName: 'span-a2',
      startTime: '2024-04-08T12:00:01.000Z',
      endTime: '2024-04-08T12:00:02.000Z',
      attributes: {},
    },
    {
      agentId: agent.id,
      traceId: TRACE_B,
      spanId: '3333333333333333',
      spanName: 'span-b1',
      startTime: '2024-04-08T12:00:03.000Z',
      endTime: '2024-04-08T12:00:04.000Z',
      attributes: {},
      txSignature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnb',
    },
  ]);

  return { app, testDb, agentId: agent.id };
}

describe('GET /api/agents/:id/reasoning', () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns all reasoning logs for the agent ordered by startTime ASC', async () => {
    const res = await ctx.app.request(`/api/agents/${ctx.agentId}/reasoning`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { reasoningLogs: Array<{ spanName: string }> };
    expect(body.reasoningLogs).toHaveLength(3);
    expect(body.reasoningLogs.map((r) => r.spanName)).toEqual(['span-a1', 'span-a2', 'span-b1']);
  });

  it('filters by traceId when provided', async () => {
    const res = await ctx.app.request(`/api/agents/${ctx.agentId}/reasoning?traceId=${TRACE_A}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { reasoningLogs: Array<{ traceId: string }> };
    expect(body.reasoningLogs).toHaveLength(2);
    for (const log of body.reasoningLogs) {
      expect(log.traceId).toBe(TRACE_A);
    }
  });

  it('returns empty array when traceId has no matches', async () => {
    const res = await ctx.app.request(
      `/api/agents/${ctx.agentId}/reasoning?traceId=${'cc00000000000000cc00000000000000'}`,
      { headers: { Authorization: BEARER } },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { reasoningLogs: unknown[] };
    expect(body.reasoningLogs).toHaveLength(0);
  });

  it('returns 422 for an invalid traceId format', async () => {
    const res = await ctx.app.request(`/api/agents/${ctx.agentId}/reasoning?traceId=not-hex`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an agent owned by another user', async () => {
    const otherApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:other-user'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    const res = await otherApp.request(`/api/agents/${ctx.agentId}/reasoning`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 without Authorization header', async () => {
    const res = await ctx.app.request(`/api/agents/${ctx.agentId}/reasoning`);
    expect(res.status).toBe(401);
  });

  it('includes txSignature in the response when present', async () => {
    const res = await ctx.app.request(`/api/agents/${ctx.agentId}/reasoning?traceId=${TRACE_B}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      reasoningLogs: Array<{ txSignature: string | null }>;
    };
    expect(body.reasoningLogs).toHaveLength(1);
    expect(body.reasoningLogs[0]?.txSignature).toBe('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnb');
  });
});
