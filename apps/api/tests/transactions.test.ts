/**
 * Integration tests for GET /api/transactions/:signature (task 3.11).
 *
 * Mirrors the patterns from agents.test.ts: full buildApp pipeline
 * over a PGlite database, fake Privy verifier, request-driven via
 * Hono's app.request().
 */

import { agentTransactions, reasoningLogs } from '@agentscope/db';
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

// A real mainnet signature shape — 88 chars of base58. We use the same
// constant in multiple tests because PG `tx_signature` is plain text,
// no extra validation on the database side.
const SIG_A =
  '5J7MhSbMxYGvL6tMo3NqJePvZKXxhKxo5oANXFp4iCLDPXm2hv5dFhMh9aaPx9EVejopBo5YD2YyoLghkqkggc8T';
const SIG_B =
  '3fXVqYvQJ6tY2qHVR7RkHUkKq4S4mhNqCXxhKxo5oANXFp4iCLDPXm2hv5dFhMh9aaPx9EVejopBo5YD2YyFEEtW';

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

async function createAgent(ctx: TestApp): Promise<{ id: string }> {
  const res = await ctx.app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: BEARER },
    body: JSON.stringify({
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'TX owner',
      framework: 'custom',
      agentType: 'other',
    }),
  });
  if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
  const body = (await res.json()) as { agent: { id: string } };
  return { id: body.agent.id };
}

async function seedTransaction(
  ctx: TestApp,
  agentId: string,
  signature: string,
  blockTime = '2026-04-08T12:00:00.000Z',
) {
  await ctx.testDb.db.insert(agentTransactions).values({
    agentId,
    signature,
    slot: 123_456,
    blockTime,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: { inputMint: 'So11111111111111111111111111111111111111112' },
    solDelta: '-0.01',
    feeLamports: 5000,
    success: true,
  });
}

describe('GET /api/transactions/:signature', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request(`/api/transactions/${SIG_A}`);
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-base58 signature', async () => {
    const res = await ctx.app.request('/api/transactions/not!!base58!!', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for a signature shorter than 64 chars', async () => {
    const res = await ctx.app.request('/api/transactions/abc123', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown but well-formed signature', async () => {
    const res = await ctx.app.request(`/api/transactions/${SIG_A}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when the tx belongs to another user (no existence oracle)', async () => {
    const agent = await createAgent(ctx);
    await seedTransaction(ctx, agent.id, SIG_A);

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });
    const res = await bobApp.request(`/api/transactions/${SIG_A}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);

    // And the row is still there for Alice.
    const [row] = await ctx.testDb.db
      .select()
      .from(agentTransactions)
      .where(eq(agentTransactions.signature, SIG_A));
    expect(row).toBeDefined();
  });

  it('returns the transaction with an empty reasoningLogs array when none exist', async () => {
    const agent = await createAgent(ctx);
    await seedTransaction(ctx, agent.id, SIG_A);

    const res = await ctx.app.request(`/api/transactions/${SIG_A}`, {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      transaction: { signature: string; instructionName: string; agentId: string };
      reasoningLogs: unknown[];
    };
    expect(body.transaction.signature).toBe(SIG_A);
    expect(body.transaction.agentId).toBe(agent.id);
    expect(body.transaction.instructionName).toBe('jupiter.swap');
    expect(body.reasoningLogs).toEqual([]);
  });

  it('returns the full span tree for correlated traces, not just tx-stamped spans', async () => {
    const agent = await createAgent(ctx);
    await seedTransaction(ctx, agent.id, SIG_A);

    // 5 spans in one trace: only span-3 carries the txSignature, but
    // the endpoint should return all 5 (the full reasoning tree) plus
    // exclude the uncorrelated span from a different trace.
    await ctx.testDb.db.insert(reasoningLogs).values([
      {
        agentId: agent.id,
        traceId: 'abcd1234abcd1234abcd1234abcd1234',
        spanId: '0000000000000001',
        spanName: 'agent.plan',
        startTime: '2026-04-08T12:00:00.000Z',
        endTime: '2026-04-08T12:00:05.000Z',
        txSignature: null,
      },
      {
        agentId: agent.id,
        traceId: 'abcd1234abcd1234abcd1234abcd1234',
        spanId: '0000000000000002',
        parentSpanId: '0000000000000001',
        spanName: 'agent.evaluate',
        startTime: '2026-04-08T12:00:01.000Z',
        endTime: '2026-04-08T12:00:02.000Z',
        txSignature: null,
      },
      {
        agentId: agent.id,
        traceId: 'abcd1234abcd1234abcd1234abcd1234',
        spanId: '0000000000000003',
        parentSpanId: '0000000000000001',
        spanName: 'agent.execute',
        startTime: '2026-04-08T12:00:02.000Z',
        endTime: '2026-04-08T12:00:04.000Z',
        txSignature: SIG_A,
      },
      {
        agentId: agent.id,
        traceId: 'abcd1234abcd1234abcd1234abcd1234',
        spanId: '0000000000000004',
        parentSpanId: '0000000000000003',
        spanName: 'solana.sendTx',
        startTime: '2026-04-08T12:00:02.500Z',
        endTime: '2026-04-08T12:00:03.000Z',
        txSignature: null,
      },
      {
        agentId: agent.id,
        traceId: 'abcd1234abcd1234abcd1234abcd1234',
        spanId: '0000000000000005',
        parentSpanId: '0000000000000001',
        spanName: 'agent.log',
        startTime: '2026-04-08T12:00:04.000Z',
        endTime: '2026-04-08T12:00:05.000Z',
        txSignature: null,
      },
      {
        // Different trace — must NOT appear.
        agentId: agent.id,
        traceId: 'ffffffffffffffffffffffffffffffff',
        spanId: 'ffffffffffffffff',
        spanName: 'unrelated',
        startTime: '2026-04-08T13:00:00.000Z',
        endTime: '2026-04-08T13:00:01.000Z',
        txSignature: null,
      },
    ]);

    const res = await ctx.app.request(`/api/transactions/${SIG_A}`, {
      headers: { Authorization: BEARER },
    });
    const body = (await res.json()) as {
      reasoningLogs: Array<{
        spanName: string;
        parentSpanId: string | null;
        txSignature: string | null;
      }>;
    };
    expect(body.reasoningLogs).toHaveLength(5);
    expect(body.reasoningLogs.map((l) => l.spanName)).toEqual([
      'agent.plan',
      'agent.evaluate',
      'agent.execute',
      'solana.sendTx',
      'agent.log',
    ]);
    // Only one span carries the txSignature; others are null
    const withSig = body.reasoningLogs.filter((l) => l.txSignature !== null);
    expect(withSig).toHaveLength(1);
    expect(withSig[0]?.spanName).toBe('agent.execute');
    // Parent-child structure preserved
    expect(body.reasoningLogs[1]?.parentSpanId).toBe('0000000000000001');
    expect(body.reasoningLogs[3]?.parentSpanId).toBe('0000000000000003');
  });

  it('distinguishes transactions by signature across multiple agents', async () => {
    const aliceAgent = await createAgent(ctx);
    await seedTransaction(ctx, aliceAgent.id, SIG_A);
    await seedTransaction(ctx, aliceAgent.id, SIG_B, '2026-04-08T13:00:00.000Z');

    const resA = await ctx.app.request(`/api/transactions/${SIG_A}`, {
      headers: { Authorization: BEARER },
    });
    const resB = await ctx.app.request(`/api/transactions/${SIG_B}`, {
      headers: { Authorization: BEARER },
    });

    const bodyA = (await resA.json()) as { transaction: { signature: string; blockTime: string } };
    const bodyB = (await resB.json()) as { transaction: { signature: string; blockTime: string } };
    expect(bodyA.transaction.signature).toBe(SIG_A);
    expect(bodyB.transaction.signature).toBe(SIG_B);
    expect(bodyA.transaction.blockTime).not.toBe(bodyB.transaction.blockTime);
  });
});
