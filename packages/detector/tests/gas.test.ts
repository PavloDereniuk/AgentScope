/**
 * Integration tests for gas_spike rule (task 5.5).
 *
 * Uses PGlite to seed historical transactions and verify the median
 * comparison logic end-to-end.
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gasRule } from '../src/rules/gas';
import type { TxRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

interface Ctx {
  testDb: TestDatabase;
  agentId: string;
}

let ctx: Ctx;

beforeAll(async () => {
  const testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:gas-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Gas Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_gas_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');

  // Seed 5 historical txs with fees: 5000, 5000, 10000, 10000, 15000
  // Median = 10000 (50th percentile of sorted [5000, 5000, 10000, 10000, 15000])
  const baseTx = {
    agentId: agent.id,
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    success: true,
  };

  await testDb.db.insert(agentTransactions).values([
    { ...baseTx, signature: 'sig_gas_1', feeLamports: 5000, blockTime: '2026-04-09T10:00:00Z' },
    { ...baseTx, signature: 'sig_gas_2', feeLamports: 5000, blockTime: '2026-04-09T10:01:00Z' },
    { ...baseTx, signature: 'sig_gas_3', feeLamports: 10000, blockTime: '2026-04-09T10:02:00Z' },
    { ...baseTx, signature: 'sig_gas_4', feeLamports: 10000, blockTime: '2026-04-09T10:03:00Z' },
    { ...baseTx, signature: 'sig_gas_5', feeLamports: 15000, blockTime: '2026-04-09T10:04:00Z' },
  ]);

  ctx = { testDb, agentId: agent.id };
});

afterAll(async () => {
  await ctx.testDb.close();
});

function makeTxCtx(fee: number, overrides: { gasMultThreshold?: number } = {}): TxRuleContext {
  return {
    agent: {
      id: ctx.agentId,
      alertRules: overrides.gasMultThreshold
        ? { gasMultThreshold: overrides.gasMultThreshold }
        : {},
    },
    defaults,
    db: ctx.testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature: 'sig_new_tx',
      instructionName: 'jupiter.swap',
      parsedArgs: {},
      solDelta: '-1.0',
      feeLamports: fee,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    },
  };
}

describe('gas_spike rule', () => {
  it('fires when fee exceeds 3× median (default threshold)', async () => {
    // Median = 10000, fee = 40000 → 4× → > 3× default → fires
    const result = await gasRule.evaluate(makeTxCtx(40000));
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('gas_spike');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ feeLamports: 40000, thresholdMult: 3 });
  });

  it('does not fire when fee is within threshold', async () => {
    // Median = 10000, fee = 25000 → 2.5× → ≤ 3× → no fire
    const result = await gasRule.evaluate(makeTxCtx(25000));
    expect(result).toBeNull();
  });

  it('uses per-agent threshold override', async () => {
    // Median = 10000, fee = 25000 → 2.5× → agent threshold 2× → fires
    const result = await gasRule.evaluate(makeTxCtx(25000, { gasMultThreshold: 2 }));
    expect(result).not.toBeNull();
  });

  it('escalates to critical at 5× threshold', async () => {
    // Median = 10000, fee = 200000 → 20× → 3× × 5 = 15× → 20 > 15 → critical
    const result = await gasRule.evaluate(makeTxCtx(200000));
    expect(result?.severity).toBe('critical');
  });

  it('skips when agent has no transaction history', async () => {
    const noHistoryCtx = makeTxCtx(40000);
    noHistoryCtx.agent = { id: '00000000-0000-0000-0000-000000000000', alertRules: {} };
    const result = await gasRule.evaluate(noHistoryCtx);
    expect(result).toBeNull();
  });
});
