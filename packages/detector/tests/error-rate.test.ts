/**
 * Integration tests for error_rate rule (task 5.6).
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorRateRule } from '../src/rules/error-rate';
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
    .values({ privyDid: 'did:privy:error-rate-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Error Rate Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_err_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');
  agentId = agent.id;

  // Seed 10 txs: 3 failed, 7 successful → 30% error rate
  const baseTx = {
    agentId: agent.id,
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
  };

  const txs = [];
  for (let i = 0; i < 10; i++) {
    txs.push({
      ...baseTx,
      signature: `sig_err_${i}`,
      success: i >= 3, // first 3 fail
      blockTime: `2026-04-09T11:${String(i * 5).padStart(2, '0')}:00Z`,
    });
  }
  await testDb.db.insert(agentTransactions).values(txs);
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(overrides: { errorRatePctThreshold?: number } = {}): CronRuleContext {
  return {
    agent: {
      id: agentId,
      alertRules: overrides.errorRatePctThreshold
        ? { errorRatePctThreshold: overrides.errorRatePctThreshold }
        : {},
    },
    defaults,
    db: testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
  };
}

describe('error_rate rule', () => {
  it('fires when error rate exceeds 20% default threshold (30% > 20%)', async () => {
    const result = await errorRateRule.evaluate(makeCtx());
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('error_rate');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ failed: 3, total: 10 });
  });

  it('does not fire when threshold is raised above actual rate', async () => {
    const result = await errorRateRule.evaluate(makeCtx({ errorRatePctThreshold: 40 }));
    expect(result).toBeNull();
  });

  it('skips when agent has no transactions', async () => {
    const ctx = makeCtx();
    ctx.agent = { id: '00000000-0000-0000-0000-000000000000', alertRules: {} };
    const result = await errorRateRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('escalates to critical when rate is 2× threshold', async () => {
    // 30% rate, threshold 10% → 3× → critical
    const result = await errorRateRule.evaluate(makeCtx({ errorRatePctThreshold: 10 }));
    expect(result?.severity).toBe('critical');
  });
});
