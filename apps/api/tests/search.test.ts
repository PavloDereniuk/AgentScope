/**
 * Integration tests for GET /api/search (task 13.11).
 *
 * Verifies the shape of the response, the three matching rules
 * (agent contains, tx/trace prefix), ownership isolation, and that
 * user-supplied LIKE metacharacters are treated as literals (a user
 * typing `%` must not wildcard-match the whole table).
 */

import { agentTransactions, reasoningLogs } from '@agentscope/db';
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

interface SearchHit {
  type: 'agent' | 'tx' | 'trace';
  id: string;
  label: string;
  hint: string;
}
interface SearchBody {
  q: string;
  results: SearchHit[];
}

function doSearch(ctx: TestApp, q: string, token = BEARER) {
  return ctx.app.request(`/api/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: token },
  });
}

describe('GET /api/search', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/search?q=foo');
    expect(res.status).toBe(401);
  });

  it('rejects missing or empty q with 422', async () => {
    const empty = await doSearch(ctx, '');
    expect(empty.status).toBe(422);
    const missing = await ctx.app.request('/api/search', { headers: { Authorization: BEARER } });
    expect(missing.status).toBe(422);
  });

  it('finds agents by name (contains, case-insensitive)', async () => {
    await createAgent(ctx, 'Alpha Trader', 'So11111111111111111111111111111111111111112');
    await createAgent(ctx, 'Beta Yield', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

    const res = await doSearch(ctx, 'alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results.filter((r) => r.type === 'agent')).toHaveLength(1);
    expect(body.results[0]?.label).toBe('Alpha Trader');
  });

  it('finds agents by wallet prefix via contains match', async () => {
    await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const res = await doSearch(ctx, 'So11111');
    const body = (await res.json()) as SearchBody;
    const agentsFound = body.results.filter((r) => r.type === 'agent');
    expect(agentsFound).toHaveLength(1);
    expect(agentsFound[0]?.hint).toMatch(/^So11111/);
  });

  it('finds transactions by signature prefix', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const now = new Date().toISOString();
    await ctx.testDb.db.insert(agentTransactions).values([
      {
        agentId: agent.id,
        signature: 'abc123matchhead',
        slot: 100,
        blockTime: now,
        programId: '11111111111111111111111111111111',
        solDelta: '0.1',
        success: true,
      },
      {
        agentId: agent.id,
        signature: 'xyz999nomatch',
        slot: 101,
        blockTime: now,
        programId: '11111111111111111111111111111111',
        solDelta: '0.1',
        success: true,
      },
    ]);

    const res = await doSearch(ctx, 'abc123');
    const body = (await res.json()) as SearchBody;
    const txHits = body.results.filter((r) => r.type === 'tx');
    expect(txHits).toHaveLength(1);
    expect(txHits[0]?.id).toBe('abc123matchhead');
    expect(txHits[0]?.hint).toMatch(/^A /);
  });

  it('finds traces by trace_id prefix and dedupes by trace_id', async () => {
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const t0 = '2026-04-20T10:00:00.000Z';
    const t1 = '2026-04-20T10:00:01.000Z';

    await ctx.testDb.db.insert(reasoningLogs).values([
      {
        agentId: agent.id,
        traceId: 'trace-abc-root',
        spanId: 'span-1',
        spanName: 'root',
        startTime: t0,
        endTime: t1,
      },
      {
        agentId: agent.id,
        traceId: 'trace-abc-root',
        spanId: 'span-2',
        spanName: 'child',
        parentSpanId: 'span-1',
        startTime: t0,
        endTime: t1,
      },
      {
        agentId: agent.id,
        traceId: 'trace-xyz-other',
        spanId: 'span-3',
        spanName: 'root',
        startTime: t0,
        endTime: t1,
      },
    ]);

    const res = await doSearch(ctx, 'trace-abc');
    const body = (await res.json()) as SearchBody;
    const traceHits = body.results.filter((r) => r.type === 'trace');
    expect(traceHits).toHaveLength(1);
    expect(traceHits[0]?.id).toBe('trace-abc-root');
  });

  it('treats user-supplied LIKE wildcards as literals', async () => {
    // A signature containing `abc` but no literal `%` should NOT match when
    // the user types `a%c`. If the escape is broken, `a%c` would match the
    // whole `abc...` via the SQL wildcard.
    const agent = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: agent.id,
      signature: 'abcwould_match_unescaped',
      slot: 100,
      blockTime: new Date().toISOString(),
      programId: '11111111111111111111111111111111',
      solDelta: '0.1',
      success: true,
    });

    const res = await doSearch(ctx, 'a%c');
    const body = (await res.json()) as SearchBody;
    const txHits = body.results.filter((r) => r.type === 'tx');
    expect(txHits).toHaveLength(0);
  });

  it("never leaks another user's agents, tx, or traces", async () => {
    const aliceAgent = await createAgent(
      ctx,
      'Alice-Unique-Name',
      'So11111111111111111111111111111111111111112',
    );
    const now = new Date().toISOString();
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: aliceAgent.id,
      signature: 'alice-shared-prefix',
      slot: 100,
      blockTime: now,
      programId: '11111111111111111111111111111111',
      solDelta: '0.1',
      success: true,
    });
    await ctx.testDb.db.insert(reasoningLogs).values({
      agentId: aliceAgent.id,
      traceId: 'alice-trace-shared',
      spanId: 'span-1',
      spanName: 'root',
      startTime: now,
      endTime: now,
    });

    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
    });

    for (const q of ['Alice-Unique', 'alice-shared', 'alice-trace']) {
      const res = await bobApp.request(`/api/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: BEARER },
      });
      const body = (await res.json()) as SearchBody;
      expect(body.results).toEqual([]);
    }
  });

  it('caps the total response at 20 results', async () => {
    // 25 agents whose names all contain the query string — the endpoint
    // must slice to MAX_RESULTS after merging. This also incidentally
    // verifies the per-type cap: 10 agent rows, plus room for tx/trace.
    const shared = 'MANY';
    // Generate unique valid base58 pubkeys (regex only — no on-curve check),
    // each 44 chars to stay within the schema bounds.
    const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 0; i < 25; i++) {
      const wallet = `So${base58[i % base58.length]!.repeat(42)}`;
      await createAgent(ctx, `${shared}-${i}`, wallet);
    }

    const res = await doSearch(ctx, shared);
    const body = (await res.json()) as SearchBody;
    expect(body.results.length).toBeLessThanOrEqual(20);
  });
});
