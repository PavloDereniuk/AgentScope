/**
 * Tests for decision_swap_mismatch rule (Epic 17).
 *
 * Seeds an agent + a jupiter.swap transaction + a MAKE_DECISION span
 * correlated by tx_signature, then exercises mismatch / match / no-span
 * paths.
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decisionSwapMismatchRule } from '../src/rules/decision-swap-mismatch';
import type { TxRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

let testDb: TestDatabase;
let agentId: string;

const TX_FLIP = 'sigflip00000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_OVER = 'sigover00000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_OK = 'sigok000000000000000000000000000000000000000000000000000000000000000000000000000';
const TX_NOSPAN =
  'signospn000000000000000000000000000000000000000000000000000000000000000000000000';

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:dsm-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'DSM Agent',
      framework: 'custom',
      agentType: 'trader',
      ingestToken: 'tok_dsm_1',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');
  agentId = agent.id;

  // Decision span for TX_FLIP — agent decided "buy" but parsedArgs say sell
  await testDb.db.insert(reasoningLogs).values({
    agentId,
    traceId: 'a'.repeat(32),
    spanId: '1'.repeat(16),
    parentSpanId: null,
    spanName: 'MAKE_DECISION',
    startTime: '2026-04-09T11:50:00Z',
    endTime: '2026-04-09T11:50:00Z',
    attributes: { 'decision.action': 'buy', 'decision.amount_sol': 0.001 },
    txSignature: TX_FLIP,
  });

  // Decision span for TX_OVER — same direction, but executed amount diverges 50%
  await testDb.db.insert(reasoningLogs).values({
    agentId,
    traceId: 'b'.repeat(32),
    spanId: '2'.repeat(16),
    parentSpanId: null,
    spanName: 'MAKE_DECISION',
    startTime: '2026-04-09T11:51:00Z',
    endTime: '2026-04-09T11:51:00Z',
    attributes: { 'decision.action': 'buy', 'decision.amount_sol': 0.001 },
    txSignature: TX_OVER,
  });

  // Decision span for TX_OK — perfect match
  await testDb.db.insert(reasoningLogs).values({
    agentId,
    traceId: 'c'.repeat(32),
    spanId: '3'.repeat(16),
    parentSpanId: null,
    spanName: 'MAKE_DECISION',
    startTime: '2026-04-09T11:52:00Z',
    endTime: '2026-04-09T11:52:00Z',
    attributes: { 'decision.action': 'buy', 'decision.amount_sol': 0.001 },
    txSignature: TX_OK,
  });
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(args: {
  signature: string;
  parsedArgs: Record<string, unknown>;
  agentThreshold?: number;
}): TxRuleContext {
  return {
    agent: {
      id: agentId,
      alertRules: args.agentThreshold ? { decisionMismatchPctThreshold: args.agentThreshold } : {},
    },
    defaults,
    db: testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature: args.signature,
      instructionName: 'jupiter.swap',
      parsedArgs: args.parsedArgs,
      solDelta: '-0.001',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T11:55:00Z',
    },
  };
}

describe('decision_swap_mismatch rule', () => {
  it('fires critical when decision.action flipped buy → sell', async () => {
    const result = await decisionSwapMismatchRule.evaluate(
      makeCtx({
        signature: TX_FLIP,
        parsedArgs: { inputMint: WSOL, outputMint: USDC, inAmount: '1000000', outAmount: '83000' },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({
      decisionAction: 'buy',
      swapSide: 'sell',
      issues: expect.arrayContaining(['action_flip']),
    });
    expect(result?.dedupeKey).toContain(TX_FLIP);
  });

  it('fires when amount diverges beyond threshold', async () => {
    // decision = 0.001 SOL, executed = 0.0015 SOL (out=1.5e6 lamports → 0.0015) → 50% delta
    const result = await decisionSwapMismatchRule.evaluate(
      makeCtx({
        signature: TX_OVER,
        parsedArgs: {
          inputMint: USDC,
          outputMint: WSOL,
          inAmount: '125000',
          outAmount: '1500000',
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({
      issues: expect.arrayContaining(['amount_mismatch']),
    });
  });

  it('does not fire when decision matches swap', async () => {
    const result = await decisionSwapMismatchRule.evaluate(
      makeCtx({
        signature: TX_OK,
        parsedArgs: {
          inputMint: USDC,
          outputMint: WSOL,
          inAmount: '83000',
          outAmount: '1000000',
        },
      }),
    );
    expect(result).toBeNull();
  });

  it('no-ops when no reasoning span correlates with the tx', async () => {
    const result = await decisionSwapMismatchRule.evaluate(
      makeCtx({
        signature: TX_NOSPAN,
        parsedArgs: {
          inputMint: USDC,
          outputMint: WSOL,
          inAmount: '83000',
          outAmount: '1000000',
        },
      }),
    );
    expect(result).toBeNull();
  });

  it('skips non-Jupiter instructions', async () => {
    const result = await decisionSwapMismatchRule.evaluate({
      ...makeCtx({
        signature: TX_FLIP,
        parsedArgs: { inputMint: WSOL, outputMint: USDC },
      }),
      transaction: {
        signature: TX_FLIP,
        instructionName: 'kamino.deposit',
        parsedArgs: {},
        solDelta: '-0.001',
        feeLamports: 5000,
        success: true,
        blockTime: '2026-04-09T11:55:00Z',
      },
    });
    expect(result).toBeNull();
  });

  it('respects per-agent threshold override', async () => {
    // 50% delta but agent set threshold to 80% → no fire
    const result = await decisionSwapMismatchRule.evaluate(
      makeCtx({
        signature: TX_OVER,
        parsedArgs: {
          inputMint: USDC,
          outputMint: WSOL,
          inAmount: '125000',
          outAmount: '1500000',
        },
        agentThreshold: 80,
      }),
    );
    expect(result).toBeNull();
  });
});
