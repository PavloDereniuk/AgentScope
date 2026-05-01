/**
 * Integration tests for GET /api/reasoning/traces/:traceId.
 *
 * Sibling of reasoning-traces.test.ts (which covers the summary list).
 * The detail endpoint returns raw spans + per-span attributes for one
 * trace, joined with the owning agent's name. Ownership isolation
 * matches the list endpoint — a foreign user cannot read someone
 * else's trace and gets 404 (existence is hidden, same shape as
 * "trace does not exist").
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:trace-detail-test';
const FOREIGN_DID = 'did:privy:trace-detail-foreign';
const BEARER = 'Bearer stub-token';

function makeVerifier(userId: string = PRIVY_DID): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

const TRACE_A = 'aaaa1111aaaa1111aaaa1111aaaa1111';
const TRACE_FOREIGN = 'ffff1111ffff1111ffff1111ffff1111';

interface TestCtx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  agentId: string;
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

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Trace Detail Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_trace_detail',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');

  // Two-span trace with parent/child structure + tx_signature on child.
  await testDb.db.insert(reasoningLogs).values([
    {
      agentId: agent.id,
      traceId: TRACE_A,
      spanId: '1111111111111111',
      spanName: 'agent.decide',
      startTime: '2026-04-30T12:00:00.000Z',
      endTime: '2026-04-30T12:00:02.000Z',
      attributes: {
        'reasoning.input': 'should I buy SOL?',
        'reasoning.output': 'yes',
        'otel.kind': 1,
      },
    },
    {
      agentId: agent.id,
      traceId: TRACE_A,
      spanId: '2222222222222222',
      parentSpanId: '1111111111111111',
      spanName: 'execute_swap',
      startTime: '2026-04-30T12:00:00.500Z',
      endTime: '2026-04-30T12:00:01.500Z',
      attributes: {
        'solana.mint': 'So11111111111111111111111111111111111111112',
        'otel.status_code': 0,
      },
      txSignature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQTnFg',
    },
  ]);

  return { app, testDb, agentId: agent.id };
}

async function seedForeign(ctx: TestCtx): Promise<void> {
  const [other] = await ctx.testDb.db.insert(users).values({ privyDid: FOREIGN_DID }).returning();
  if (!other) throw new Error('seed foreign user failed');
  const [foreignAgent] = await ctx.testDb.db
    .insert(agents)
    .values({
      userId: other.id,
      walletPubkey: '22222222222222222222222222222222',
      name: 'Foreign Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_foreign_detail',
    })
    .returning();
  if (!foreignAgent) throw new Error('seed foreign agent failed');
  await ctx.testDb.db.insert(reasoningLogs).values({
    agentId: foreignAgent.id,
    traceId: TRACE_FOREIGN,
    spanId: '3333333333333333',
    spanName: 'foreign.action',
    startTime: '2026-04-30T13:00:00.000Z',
    endTime: '2026-04-30T13:00:00.500Z',
    attributes: { secret: 'should-not-leak' },
  });
}

interface SpanRow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, unknown>;
  txSignature: string | null;
  agentId: string;
  agentName: string;
  agentWalletPubkey: string;
}

interface TraceDetailResponse {
  traceId: string;
  spans: SpanRow[];
  truncated: boolean;
}

describe('GET /api/reasoning/traces/:traceId', () => {
  let ctx: TestCtx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns spans ordered by startTime with full attributes and agent metadata', async () => {
    const res = await ctx.app.request(`/api/reasoning/traces/${TRACE_A}`, {
      headers: { Authorization: BEARER },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceDetailResponse;
    expect(body.traceId).toBe(TRACE_A);
    expect(body.truncated).toBe(false);
    expect(body.spans).toHaveLength(2);

    const [root, child] = body.spans;
    expect(root?.spanName).toBe('agent.decide');
    expect(root?.parentSpanId).toBeNull();
    expect(root?.attributes['reasoning.input']).toBe('should I buy SOL?');
    expect(root?.attributes['otel.kind']).toBe(1);
    expect(root?.agentName).toBe('Trace Detail Agent');
    expect(root?.agentId).toBe(ctx.agentId);

    expect(child?.spanName).toBe('execute_swap');
    expect(child?.parentSpanId).toBe('1111111111111111');
    expect(child?.txSignature).toBe('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQTnFg');
  });

  it('returns 404 when traceId belongs to another user (does not leak existence)', async () => {
    await seedForeign(ctx);

    const res = await ctx.app.request(`/api/reasoning/traces/${TRACE_FOREIGN}`, {
      headers: { Authorization: BEARER },
    });

    // 404 not 403 — same shape as "trace does not exist".
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('not found');
  });

  it('returns 404 for a syntactically valid traceId that has no spans', async () => {
    const res = await ctx.app.request('/api/reasoning/traces/9999999999999999999999999999999a', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 when traceId param is not 32 lowercase hex', async () => {
    const res = await ctx.app.request('/api/reasoning/traces/not-a-trace-id', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('requires authentication (no bearer → 401)', async () => {
    const res = await ctx.app.request(`/api/reasoning/traces/${TRACE_A}`);
    expect(res.status).toBe(401);
  });
});
