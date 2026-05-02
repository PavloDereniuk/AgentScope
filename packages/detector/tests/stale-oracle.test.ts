/**
 * Tests for stale_oracle rule (Epic 17).
 *
 * Seeds an agent + reasoning trace with ANALYZE_MARKET (market.price_usd)
 * and MAKE_DECISION (decision.price_usd) spans, then exercises divergent /
 * matching / partial-data paths.
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staleOracleRule } from '../src/rules/stale-oracle';
import type { TxRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

let testDb: TestDatabase;
let agentId: string;

const TX_DRIFT =
  'sigdrft00000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_MATCH =
  'sigmtch00000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_PARTIAL =
  'sigpart00000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_NOSPAN =
  'signone00000000000000000000000000000000000000000000000000000000000000000000000000';

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:so-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'SO Agent',
      framework: 'custom',
      agentType: 'trader',
      ingestToken: 'tok_so_1',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');
  agentId = agent.id;

  // Trace 1 — DRIFT: market $100, decision $90 → 10% divergence
  await testDb.db.insert(reasoningLogs).values([
    {
      agentId,
      traceId: 'd'.repeat(32),
      spanId: 'a'.repeat(16),
      parentSpanId: null,
      spanName: 'ANALYZE_MARKET',
      startTime: '2026-04-09T11:50:00Z',
      endTime: '2026-04-09T11:50:00Z',
      attributes: { 'market.price_usd': 100, 'reasoning.source': 'coingecko' },
      txSignature: null,
    },
    {
      agentId,
      traceId: 'd'.repeat(32),
      spanId: 'b'.repeat(16),
      parentSpanId: null,
      spanName: 'MAKE_DECISION',
      startTime: '2026-04-09T11:50:01Z',
      endTime: '2026-04-09T11:50:01Z',
      attributes: { 'decision.price_usd': 90, 'decision.action': 'buy' },
      txSignature: null,
    },
    {
      agentId,
      traceId: 'd'.repeat(32),
      spanId: 'c'.repeat(16),
      parentSpanId: null,
      spanName: 'EXECUTE_SWAP',
      startTime: '2026-04-09T11:50:02Z',
      endTime: '2026-04-09T11:50:02Z',
      attributes: {},
      txSignature: TX_DRIFT,
    },
  ]);

  // Trace 2 — MATCH: market $100, decision $100.5 → 0.5% divergence (under default 1%)
  await testDb.db.insert(reasoningLogs).values([
    {
      agentId,
      traceId: 'e'.repeat(32),
      spanId: 'd'.repeat(16),
      parentSpanId: null,
      spanName: 'ANALYZE_MARKET',
      startTime: '2026-04-09T11:51:00Z',
      endTime: '2026-04-09T11:51:00Z',
      attributes: { 'market.price_usd': 100 },
      txSignature: null,
    },
    {
      agentId,
      traceId: 'e'.repeat(32),
      spanId: 'e'.repeat(16),
      parentSpanId: null,
      spanName: 'MAKE_DECISION',
      startTime: '2026-04-09T11:51:01Z',
      endTime: '2026-04-09T11:51:01Z',
      attributes: { 'decision.price_usd': 100.5 },
      txSignature: TX_MATCH,
    },
  ]);

  // Trace 3 — PARTIAL: only ANALYZE_MARKET, no MAKE_DECISION price
  await testDb.db.insert(reasoningLogs).values({
    agentId,
    traceId: 'f'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    spanName: 'ANALYZE_MARKET',
    startTime: '2026-04-09T11:52:00Z',
    endTime: '2026-04-09T11:52:00Z',
    attributes: { 'market.price_usd': 100 },
    txSignature: TX_PARTIAL,
  });
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(signature: string, agentThreshold?: number): TxRuleContext {
  return {
    agent: {
      id: agentId,
      alertRules: agentThreshold ? { staleOraclePctThreshold: agentThreshold } : {},
    },
    defaults,
    db: testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature,
      instructionName: 'jupiter.swap',
      parsedArgs: {},
      solDelta: '-0.001',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T11:55:00Z',
    },
  };
}

describe('stale_oracle rule', () => {
  it('fires critical when divergence is 10× threshold', async () => {
    // 10% divergence vs default 1% threshold → 10× → critical
    const result = await staleOracleRule.evaluate(makeCtx(TX_DRIFT));
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({
      marketPriceUsd: 100,
      decisionPriceUsd: 90,
    });
    expect(typeof (result?.payload as { divergencePct: number }).divergencePct).toBe('number');
    expect(result?.dedupeKey).toContain(TX_DRIFT);
  });

  it('does not fire when divergence is under threshold', async () => {
    const result = await staleOracleRule.evaluate(makeCtx(TX_MATCH));
    expect(result).toBeNull();
  });

  it('no-ops when MAKE_DECISION span has no price', async () => {
    const result = await staleOracleRule.evaluate(makeCtx(TX_PARTIAL));
    expect(result).toBeNull();
  });

  it('no-ops when no spans correlate with the tx', async () => {
    const result = await staleOracleRule.evaluate(makeCtx(TX_NOSPAN));
    expect(result).toBeNull();
  });

  it('respects per-agent threshold override (suppresses 10% drift at 20%)', async () => {
    const result = await staleOracleRule.evaluate(makeCtx(TX_DRIFT, 20));
    expect(result).toBeNull();
  });

  it('fires warning at agent threshold > 1× but < 5×', async () => {
    // 10% drift, agent threshold 5% → 2× → warning (not critical)
    const result = await staleOracleRule.evaluate(makeCtx(TX_DRIFT, 5));
    expect(result?.severity).toBe('warning');
  });
});
