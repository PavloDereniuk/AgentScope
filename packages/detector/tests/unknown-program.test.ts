/**
 * Integration tests for unknown_program_interaction rule (A.9).
 *
 * Seeds an agent with history so the rule can distinguish "program the agent
 * has used before" from genuine first contact, and covers the two escalation
 * inputs (SOL outflow beyond fee, SPL token outflow).
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import type { SolanaPubkey, TokenDelta } from '@agentscope/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unknownProgramRule } from '../src/rules/unknown-program';
import type { TxRuleContext, TxSnapshot } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Never seen by the agent — the first-contact subject of most cases. */
const FRESH_PROGRAM = 'Drainer1nteractionProgram11111111111111111';
/** Seen 5 days ago — inside the default 30-day lookback. */
const SEEN_PROGRAM = 'Fami1iarUnnamedProgram1111111111111111111';
/** Seen 40 days ago — outside the default lookback, so it counts as new again. */
const STALE_PROGRAM = 'Sta1eUnnamedProgram111111111111111111111';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as SolanaPubkey;

const NOW = new Date('2026-07-20T12:00:00Z');

function makeTokenDelta(delta: string): TokenDelta {
  return { mint: USDC, decimals: 6, delta };
}

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

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
  unknownProgramLookbackDays: 30,
  outboundDrainPct: 25,
};

interface Ctx {
  testDb: TestDatabase;
  /** Agent with prior history — the normal case. */
  agentId: string;
  /** Agent with zero transactions — the cold-start case. */
  freshAgentId: string;
}

let ctx: Ctx;

beforeAll(async () => {
  const testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:unknown-program-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Unknown Program Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_unknown_program_test',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');

  const [freshAgent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111112',
      name: 'Cold Start Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_unknown_program_cold',
    })
    .returning();
  if (!freshAgent) throw new Error('seed fresh agent failed');

  const baseTx = {
    agentId: agent.id,
    slot: 100,
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
  };

  await testDb.db.insert(agentTransactions).values([
    // Ordinary in-window history — also what lifts the agent out of cold start.
    {
      ...baseTx,
      signature: 'sig_up_jup_1',
      programId: JUPITER_PROGRAM,
      instructionName: 'jupiter.swap',
      blockTime: daysAgo(2),
    },
    {
      ...baseTx,
      signature: 'sig_up_jup_2',
      programId: JUPITER_PROGRAM,
      instructionName: 'jupiter.swap',
      blockTime: daysAgo(1),
    },
    // Unnamed program the agent already used inside the window.
    {
      ...baseTx,
      signature: 'sig_up_seen',
      programId: SEEN_PROGRAM,
      instructionName: 'fami.unknown',
      blockTime: daysAgo(5),
    },
    // Unnamed program last used before the window opened.
    {
      ...baseTx,
      signature: 'sig_up_stale',
      programId: STALE_PROGRAM,
      instructionName: 'sta1.unknown',
      blockTime: daysAgo(40),
    },
  ]);

  ctx = { testDb, agentId: agent.id, freshAgentId: freshAgent.id };
});

afterAll(async () => {
  await ctx.testDb.close();
});

function makeTxCtx(
  tx: Partial<TxSnapshot> = {},
  opts: { agentId?: string; lookbackDays?: number } = {},
): TxRuleContext {
  return {
    agent: {
      id: opts.agentId ?? ctx.agentId,
      alertRules:
        opts.lookbackDays !== undefined
          ? { unknownProgramLookbackDaysThreshold: opts.lookbackDays }
          : {},
    },
    defaults,
    db: ctx.testDb.db,
    now: NOW,
    transaction: {
      signature: 'sig_up_new',
      slot: 200,
      instructionName: 'drai.unknown',
      parsedArgs: {},
      // Fee-only SOL change: the wallet paid 5000 lamports and nothing else,
      // so this default snapshot carries no outflow.
      solDelta: '-0.000005000',
      tokenDeltas: [],
      feeLamports: 5000,
      success: true,
      blockTime: NOW.toISOString(),
      programId: FRESH_PROGRAM,
      ...tx,
    },
  };
}

describe('unknown_program_interaction rule', () => {
  it('fires warning on first contact with an unnamed program', async () => {
    const result = await unknownProgramRule.evaluate(makeTxCtx());
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('unknown_program_interaction');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      programId: FRESH_PROGRAM,
      lookbackDays: 30,
      instructionName: 'drai.unknown',
      signature: 'sig_up_new',
      solOutflow: 0,
      tokenOutflowCount: 0,
    });
  });

  it('abstains for a program on the known-program whitelist', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ programId: JUPITER_PROGRAM, instructionName: 'jupiter.swap' }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the agent already used this program inside the window', async () => {
    const result = await unknownProgramRule.evaluate(makeTxCtx({ programId: SEEN_PROGRAM }));
    expect(result).toBeNull();
  });

  it('fires when the only prior use is older than the lookback window', async () => {
    const result = await unknownProgramRule.evaluate(makeTxCtx({ programId: STALE_PROGRAM }));
    expect(result).not.toBeNull();
    expect(result?.payload.programId).toBe(STALE_PROGRAM);
  });

  it('honours a per-agent lookback override', async () => {
    // 60-day window swallows the 40-day-old interaction → familiar again.
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ programId: STALE_PROGRAM }, { lookbackDays: 60 }),
    );
    expect(result).toBeNull();
  });

  it('escalates to critical when SOL leaves the wallet beyond the fee', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ solDelta: '-0.420005000', feeLamports: 5000 }),
    );
    expect(result?.severity).toBe('critical');
    expect(result?.payload.solOutflow).toBeCloseTo(0.42, 9);
  });

  it('escalates to critical when SPL tokens leave the wallet', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ tokenDeltas: [makeTokenDelta('-1500')] }),
    );
    expect(result?.severity).toBe('critical');
    expect(result?.payload.tokenOutflowCount).toBe(1);
  });

  it('stays warning when tokens only arrive (positive delta)', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ tokenDeltas: [makeTokenDelta('1500')] }),
    );
    expect(result?.severity).toBe('warning');
  });

  it('detects an unnamed program hiding in a non-primary instruction', async () => {
    // Primary instruction is a decoded Jupiter swap; the fresh program only
    // shows up in the `_all` outline (E.5). A drainer CPI'd alongside a real
    // swap must not slip through just because it lost the primary pick.
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({
        programId: JUPITER_PROGRAM,
        instructionName: 'jupiter.swap',
        parsedArgs: {
          _all: [
            { index: 0, programId: JUPITER_PROGRAM, name: 'jupiter.swap' },
            { index: 1, programId: FRESH_PROGRAM, name: 'drai.unknown' },
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.payload.programId).toBe(FRESH_PROGRAM);
    expect(result?.payload.newProgramIds).toEqual([FRESH_PROGRAM]);
  });

  it('reports every new program when a tx touches more than one', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({
        parsedArgs: {
          _all: [
            { index: 0, programId: FRESH_PROGRAM, name: 'drai.unknown' },
            { index: 1, programId: STALE_PROGRAM, name: 'sta1.unknown' },
            { index: 2, programId: SEEN_PROGRAM, name: 'fami.unknown' },
            { index: 3, programId: JUPITER_PROGRAM, name: 'jupiter.swap' },
          ],
        },
      }),
    );
    expect(result?.payload.newProgramIds).toEqual([FRESH_PROGRAM, STALE_PROGRAM]);
  });

  it('ignores malformed `_all` entries instead of throwing', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({
        parsedArgs: { _all: [null, 42, { index: 0 }, { programId: 7 }, 'nope'] },
      }),
    );
    // Falls back to the snapshot's own programId, which is still first contact.
    expect(result?.payload.programId).toBe(FRESH_PROGRAM);
  });

  it('ignores the current tx when reading history (it is persisted first)', async () => {
    // persist.ts inserts the row *before* running tx rules, so the rule must
    // exclude its own signature or it would never see a program as new.
    await ctx.testDb.db.insert(agentTransactions).values({
      agentId: ctx.agentId,
      signature: 'sig_up_selfref',
      slot: 201,
      programId: 'Se1fReferentia1Program11111111111111111111',
      instructionName: 'se1f.unknown',
      parsedArgs: {},
      solDelta: '0',
      feeLamports: 5000,
      success: true,
      blockTime: NOW.toISOString(),
    });

    const result = await unknownProgramRule.evaluate(
      makeTxCtx({
        signature: 'sig_up_selfref',
        programId: 'Se1fReferentia1Program11111111111111111111',
      }),
    );
    expect(result).not.toBeNull();
  });

  it('abstains on cold start — agent has no history to compare against', async () => {
    const result = await unknownProgramRule.evaluate(makeTxCtx({}, { agentId: ctx.freshAgentId }));
    expect(result).toBeNull();
  });

  it('abstains when the snapshot carries no program id at all', async () => {
    const base = makeTxCtx();
    const noProgram: TxRuleContext = {
      ...base,
      transaction: { ...base.transaction, programId: undefined },
    };
    expect(await unknownProgramRule.evaluate(noProgram)).toBeNull();
  });

  it('abstains for a non-positive lookback (misconfig guard)', async () => {
    const result = await unknownProgramRule.evaluate(makeTxCtx({}, { lookbackDays: 0 }));
    expect(result).toBeNull();
  });

  it('dedupes per program and severity', async () => {
    const warning = await unknownProgramRule.evaluate(makeTxCtx());
    expect(warning?.dedupeKey).toBe(`unknown_program:${FRESH_PROGRAM}:warning`);

    // A later drain on the same program must still get through — dedupe on the
    // program alone would swallow the alert that actually matters.
    const critical = await unknownProgramRule.evaluate(makeTxCtx({ solDelta: '-1.000005000' }));
    expect(critical?.dedupeKey).toBe(`unknown_program:${FRESH_PROGRAM}:critical`);
  });

  it('does not escalate a failed tx (no funds actually moved)', async () => {
    const result = await unknownProgramRule.evaluate(
      makeTxCtx({ success: false, solDelta: '-0.000005000' }),
    );
    expect(result?.severity).toBe('warning');
  });
});
