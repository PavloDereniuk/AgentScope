/**
 * Integration tests for priority_fee_spike rule (A.8).
 *
 * Seeds historical transactions for a specific program and verifies the
 * per-program median comparison logic end-to-end.
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { priorityFeeRule } from '../src/rules/priority-fee';
import type { TxRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const OTHER_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
  lowBalanceSol: 0.005,
  txRateMaxPerMin: 30,
  priorityFeeMult: 10,
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
    .values({ privyDid: 'did:privy:pfee-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Priority Fee Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_pfee_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');

  // Seed 5 Jupiter txs with fees: 5000, 5000, 10000, 10000, 15000
  // Median for JUPITER_PROGRAM = 10000
  const baseTx = {
    agentId: agent.id,
    slot: 100,
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    success: true,
  };

  await testDb.db.insert(agentTransactions).values([
    {
      ...baseTx,
      signature: 'sig_pf_1',
      programId: JUPITER_PROGRAM,
      feeLamports: 5000,
      blockTime: '2026-04-09T10:00:00Z',
    },
    {
      ...baseTx,
      signature: 'sig_pf_2',
      programId: JUPITER_PROGRAM,
      feeLamports: 5000,
      blockTime: '2026-04-09T10:01:00Z',
    },
    {
      ...baseTx,
      signature: 'sig_pf_3',
      programId: JUPITER_PROGRAM,
      feeLamports: 10000,
      blockTime: '2026-04-09T10:02:00Z',
    },
    {
      ...baseTx,
      signature: 'sig_pf_4',
      programId: JUPITER_PROGRAM,
      feeLamports: 10000,
      blockTime: '2026-04-09T10:03:00Z',
    },
    {
      ...baseTx,
      signature: 'sig_pf_5',
      programId: JUPITER_PROGRAM,
      feeLamports: 15000,
      blockTime: '2026-04-09T10:04:00Z',
    },
    // One tx for OTHER_PROGRAM with very different fee — must not pollute Jupiter median
    {
      ...baseTx,
      signature: 'sig_pf_other',
      programId: OTHER_PROGRAM,
      feeLamports: 1000000,
      blockTime: '2026-04-09T10:05:00Z',
    },
  ]);

  ctx = { testDb, agentId: agent.id };
});

afterAll(async () => {
  await ctx.testDb.close();
});

function makeTxCtx(
  fee: number,
  programId: string | undefined = JUPITER_PROGRAM,
  overrides: { priorityFeeMultThreshold?: number } = {},
): TxRuleContext {
  return {
    agent: {
      id: ctx.agentId,
      alertRules:
        overrides.priorityFeeMultThreshold !== undefined
          ? { priorityFeeMultThreshold: overrides.priorityFeeMultThreshold }
          : {},
    },
    defaults,
    db: ctx.testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature: 'sig_new_pf',
      slot: 101,
      instructionName: 'jupiter.swap',
      parsedArgs: {},
      solDelta: '-1.0',
      tokenDeltas: [],
      feeLamports: fee,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
      programId,
    },
  };
}

describe('priority_fee_spike rule', () => {
  it('fires when fee exceeds 10× program median (default threshold)', async () => {
    // Jupiter median = 10000, fee = 120000 → 12× > 10× → fires
    const result = await priorityFeeRule.evaluate(makeTxCtx(120000));
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('priority_fee_spike');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      feeLamports: 120000,
      thresholdMult: 10,
      programId: JUPITER_PROGRAM,
    });
  });

  it('does not fire when fee is within threshold', async () => {
    // Jupiter median = 10000, fee = 80000 → 8× ≤ 10× → no fire
    const result = await priorityFeeRule.evaluate(makeTxCtx(80000));
    expect(result).toBeNull();
  });

  it('uses per-agent threshold override', async () => {
    // Jupiter median = 10000, fee = 60000 → 6× > custom threshold 5× → fires
    const result = await priorityFeeRule.evaluate(
      makeTxCtx(60000, JUPITER_PROGRAM, { priorityFeeMultThreshold: 5 }),
    );
    expect(result).not.toBeNull();
    expect(result?.payload.thresholdMult).toBe(5);
  });

  it('escalates to critical at 5× threshold', async () => {
    // Jupiter median = 10000, threshold = 10, critical at 10×5=50×
    // fee = 520000 → 52× > 50× → critical
    const result = await priorityFeeRule.evaluate(makeTxCtx(520000));
    expect(result?.severity).toBe('critical');
  });

  it('uses per-program median — not polluted by other programs', async () => {
    // OTHER_PROGRAM has only 1 tx with 1_000_000 lamports (extreme fee)
    // Jupiter median is 10000 — query must filter by programId
    // Jupiter fee = 120000 → fires based on Jupiter median (not Other)
    const result = await priorityFeeRule.evaluate(makeTxCtx(120000, JUPITER_PROGRAM));
    expect(result).not.toBeNull();
    // If it used Other's median (1_000_000), 120000 would be below threshold — so
    // the fact it fires confirms program isolation.
    expect(result?.payload.medianFeeLamports).toBe(10000);
  });

  it('abstains when programId is absent from snapshot', async () => {
    // Build ctx without programId to simulate legacy/missing field
    const baseCtx = makeTxCtx(9999999);
    const ctxNoProgramId: TxRuleContext = {
      ...baseCtx,
      transaction: { ...baseCtx.transaction, programId: undefined },
    };
    const result = await priorityFeeRule.evaluate(ctxNoProgramId);
    expect(result).toBeNull();
  });

  it('abstains when agent has no history for this program', async () => {
    const unknownCtx = makeTxCtx(9999999);
    unknownCtx.agent = { id: '00000000-0000-0000-0000-000000000000', alertRules: {} };
    const result = await priorityFeeRule.evaluate(unknownCtx);
    expect(result).toBeNull();
  });

  it('abstains for zero or non-positive threshold (misconfig guard)', async () => {
    const result = await priorityFeeRule.evaluate(
      makeTxCtx(9999999, JUPITER_PROGRAM, { priorityFeeMultThreshold: 0 }),
    );
    expect(result).toBeNull();
  });

  it('includes dedupeKey scoped to signature', async () => {
    const result = await priorityFeeRule.evaluate(makeTxCtx(120000));
    expect(result?.dedupeKey).toBe('priority_fee:sig_new_pf');
  });
});
