/**
 * Integration tests for drawdown rule (task 5.7).
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawdownRule } from '../src/rules/drawdown';
import type { CronRuleContext } from '../src/types';
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

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:drawdown-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Drawdown Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_dd_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');
  agentId = agent.id;

  // Seed txs with net -0.25 SOL loss in the last hour
  // -0.1 + -0.2 + 0.05 = -0.25 SOL → 25% of 1 SOL reference
  const baseTx = {
    agentId: agent.id,
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    feeLamports: 5000,
    success: true,
  };

  await testDb.db.insert(agentTransactions).values([
    { ...baseTx, signature: 'sig_dd_1', solDelta: '-0.1', blockTime: '2026-04-09T11:10:00Z' },
    { ...baseTx, signature: 'sig_dd_2', solDelta: '-0.2', blockTime: '2026-04-09T11:20:00Z' },
    { ...baseTx, signature: 'sig_dd_3', solDelta: '0.05', blockTime: '2026-04-09T11:30:00Z' },
  ]);
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(overrides: { drawdownPctThreshold?: number } = {}): CronRuleContext {
  return {
    agent: {
      id: agentId,
      alertRules: overrides.drawdownPctThreshold
        ? { drawdownPctThreshold: overrides.drawdownPctThreshold }
        : {},
    },
    defaults,
    db: testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
  };
}

describe('drawdown rule', () => {
  it('fires when 1h drawdown exceeds 10% default (25% > 10%)', async () => {
    const result = await drawdownRule.evaluate(makeCtx());
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('drawdown');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ thresholdPct: 10 });
    expect((result?.payload as Record<string, number>).drawdownPct).toBeCloseTo(25, 0);
  });

  it('does not fire when threshold is above actual drawdown', async () => {
    const result = await drawdownRule.evaluate(makeCtx({ drawdownPctThreshold: 30 }));
    expect(result).toBeNull();
  });

  it('skips when no transactions in window', async () => {
    const ctx = makeCtx();
    ctx.agent = { id: '00000000-0000-0000-0000-000000000000', alertRules: {} };
    const result = await drawdownRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('escalates to critical at 3× threshold', async () => {
    // 25% drawdown, threshold 5% → 5× → critical
    const result = await drawdownRule.evaluate(makeCtx({ drawdownPctThreshold: 5 }));
    expect(result?.severity).toBe('critical');
  });
});
