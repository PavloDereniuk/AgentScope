/**
 * Integration tests for token_approval_anomaly rule (post-MVP roadmap A.10).
 *
 * Same PGlite pattern as unknown_program / transfer_drain: real migrations
 * against an in-memory Postgres, seeded history, then a synthetic TxSnapshot
 * shaped exactly like the one persist.ts hands the tx-runner.
 *
 * The distinguishing property of this rule: the transaction under test moves
 * no money at all. Every fixture below has `solDelta: '0'` and empty
 * `tokenDeltas` — if the rule ever starts needing a balance change to fire, it
 * has stopped detecting the thing it exists for.
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenApprovalRule } from '../src/rules/token-approval';
import type { TxRuleContext, TxSnapshot } from '../src/types';

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

const NOW = new Date('2026-08-11T12:00:00Z');
const TOKEN_PROGRAM = 'TokenkegQfZFAhUJMRNbSL2vM5qTgaK5TxwQnEKL7aP';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const UNLIMITED = '18446744073709551615';
const MINT = 'MintUSDC111111111111111111111111';
const SOURCE_ATA = 'SourceAta1111111111111111111111111';
const WALLET = 'Wa11etApprova111111111111111111111';
const OWNER = WALLET;

/** Delegate the agent has approved for weeks — a router it actually uses. */
const KNOWN_DELEGATE = 'KnownDe1egate1111111111111111111';
/** Delegate nobody has ever seen — the one a drainer plants. */
const FRESH_DELEGATE = 'FreshDe1egate1111111111111111111';

import { type TestDatabase, createTestDatabase } from './helpers/test-db';

let testDb: TestDatabase;
/** Agent with a month of history, including approvals to KNOWN_DELEGATE. */
let agentId: string;
/** Agent whose very first transaction is the one under test. */
let coldAgentId: string;

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

interface ApprovalEntry {
  index?: number;
  delegate: string;
  amount: string;
  source?: string;
  owner?: string;
  /** Explicit `undefined` drops the key — the no-mint-in-meta case. */
  mint?: string | undefined;
  programId?: string;
}

function approvalEntry(entry: ApprovalEntry): Record<string, unknown> {
  return {
    index: entry.index ?? 0,
    delegate: entry.delegate,
    amount: entry.amount,
    source: entry.source ?? SOURCE_ATA,
    owner: entry.owner ?? OWNER,
    // An explicit `mint: undefined` drops the key entirely — that is how the
    // parser leaves it when tx meta carried no balance for the token account.
    ...('mint' in entry ? (entry.mint ? { mint: entry.mint } : {}) : { mint: MINT }),
    programId: entry.programId ?? TOKEN_PROGRAM,
  };
}

/** A persisted row carrying approvals, exactly as persistTx writes it. */
function approvalRow(opts: {
  agentId: string;
  signature: string;
  at: string;
  approvals: ApprovalEntry[];
  primaryName?: string;
}) {
  return {
    agentId: opts.agentId,
    signature: opts.signature,
    slot: 100,
    blockTime: opts.at,
    programId: TOKEN_PROGRAM,
    instructionName: opts.primaryName ?? 'spl_token.approve',
    parsedArgs: {
      _all: [{ index: 0, programId: TOKEN_PROGRAM, name: 'spl_token.approve' }],
      _approvals: opts.approvals.map(approvalEntry),
    },
    solDelta: '0.000000000',
    tokenDeltas: [],
    feeLamports: 5000,
    success: true,
  };
}

/** Plain history that establishes a baseline without approving anyone. */
function swapRow(id: string, signature: string, at: string) {
  return {
    agentId: id,
    signature,
    slot: 100,
    blockTime: at,
    programId: JUPITER_PROGRAM,
    instructionName: 'jupiter.swap',
    parsedArgs: { _all: [{ index: 0, programId: JUPITER_PROGRAM, name: 'jupiter.swap' }] },
    solDelta: '-0.000005000',
    tokenDeltas: [],
    feeLamports: 5000,
    success: true,
  };
}

/** The tx under test — never persisted with money attached. */
function snapshot(opts: {
  signature: string;
  approvals?: ApprovalEntry[];
  parsedArgs?: Record<string, unknown> | null;
  instructionName?: string | null;
  success?: boolean;
}): TxSnapshot {
  const parsedArgs =
    opts.parsedArgs !== undefined
      ? opts.parsedArgs
      : {
          _all: [{ index: 0, programId: TOKEN_PROGRAM, name: 'spl_token.approve' }],
          _approvals: (opts.approvals ?? []).map(approvalEntry),
        };
  return {
    signature: opts.signature,
    slot: 200,
    instructionName:
      opts.instructionName !== undefined ? opts.instructionName : 'spl_token.approve',
    parsedArgs,
    solDelta: '0.000000000',
    tokenDeltas: [],
    feeLamports: 5000,
    success: opts.success ?? true,
    blockTime: NOW.toISOString(),
    programId: TOKEN_PROGRAM,
  };
}

function ctxFor(id: string, transaction: TxSnapshot): TxRuleContext {
  return {
    agent: { id, alertRules: {}, walletPubkey: WALLET },
    defaults,
    db: testDb.db,
    now: NOW,
    transaction,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:token-approval-test' })
    .returning();
  if (!user) throw new Error('seed user failed');
  const userId = user.id;

  async function makeAgent(name: string, token: string, wallet: string): Promise<string> {
    const [a] = await testDb.db
      .insert(agents)
      .values({
        userId,
        walletPubkey: wallet,
        name,
        framework: 'custom',
        agentType: 'other',
        ingestToken: token,
      })
      .returning();
    if (!a) throw new Error(`seed agent ${name} failed`);
    return a.id;
  }

  agentId = await makeAgent('Approver', 'tok_approve', WALLET);
  coldAgentId = await makeAgent('Cold', 'tok_cold_approve', 'Wa11etCo1dApprove111111111111111');

  await testDb.db.insert(agentTransactions).values([
    // Baseline history plus two bounded approvals to a delegate the agent uses.
    swapRow(agentId, 'sig_hist_swap', isoDaysAgo(10)),
    approvalRow({
      agentId,
      signature: 'sig_hist_approve_known',
      at: isoDaysAgo(9),
      approvals: [{ delegate: KNOWN_DELEGATE, amount: '1000000' }],
    }),
    approvalRow({
      agentId,
      signature: 'sig_hist_approve_known_2',
      at: isoDaysAgo(2),
      approvals: [{ delegate: KNOWN_DELEGATE, amount: '2000000' }],
    }),
    // Same delegate, but the approval is older than the 30-day window.
    approvalRow({
      agentId,
      signature: 'sig_hist_approve_stale',
      at: isoDaysAgo(45),
      approvals: [{ delegate: 'Sta1eDe1egate111111111111111111', amount: '1000000' }],
    }),
  ]);
});

afterAll(async () => {
  await testDb.close();
});

describe('token_approval_anomaly — firing', () => {
  it('fires warning on a bounded approval to a delegate never seen before', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_fresh_bounded',
          approvals: [{ delegate: FRESH_DELEGATE, amount: '5000000' }],
        }),
      ),
    );

    expect(result).not.toBeNull();
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      delegate: FRESH_DELEGATE,
      mint: MINT,
      tokenAccount: SOURCE_ATA,
      amount: '5000000',
      unlimited: false,
      unfamiliarDelegate: true,
      lookbackDays: 30,
    });
  });

  it('escalates to critical for an unlimited approval to an unknown delegate', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_fresh_unlimited',
          approvals: [{ delegate: FRESH_DELEGATE, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ unlimited: true, amount: UNLIMITED });
  });

  it('still fires (warning) when the unlimited allowance goes to a known delegate', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_known_unlimited',
          approvals: [{ delegate: KNOWN_DELEGATE, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ unlimited: true, unfamiliarDelegate: false });
  });

  it('sees an approval hidden behind a swap as the primary instruction', async () => {
    // The whole reason `_approvals` exists: the top-level args belong to the
    // swap, and the approval rides in position two.
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_bundled',
          instructionName: 'jupiter.swap',
          parsedArgs: {
            inAmount: '1000000',
            slippageBps: 50,
            _all: [
              { index: 0, programId: JUPITER_PROGRAM, name: 'jupiter.swap' },
              { index: 1, programId: TOKEN_PROGRAM, name: 'spl_token.approve' },
            ],
            _approvals: [approvalEntry({ index: 1, delegate: FRESH_DELEGATE, amount: UNLIMITED })],
          },
        }),
      ),
    );

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ delegate: FRESH_DELEGATE });
  });

  it('reports the worst approval when a tx grants several', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_multi',
          approvals: [
            { index: 0, delegate: KNOWN_DELEGATE, amount: '10' },
            { index: 1, delegate: FRESH_DELEGATE, amount: UNLIMITED },
          ],
        }),
      ),
    );

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ delegate: FRESH_DELEGATE, approvalCount: 2 });
  });

  it('treats a delegate whose only approval predates the window as unfamiliar', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_stale_delegate',
          approvals: [{ delegate: 'Sta1eDe1egate111111111111111111', amount: '1000' }],
        }),
      ),
    );

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ unfamiliarDelegate: true });
  });

  it('reads a legacy row where the approval sits in the top-level args', async () => {
    // Rows written before persistence built `_approvals`: the primary
    // instruction is the approval itself, so its args are at the top level.
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_legacy_shape',
          instructionName: 'spl_token.approve',
          parsedArgs: {
            source: SOURCE_ATA,
            delegate: FRESH_DELEGATE,
            owner: OWNER,
            amount: UNLIMITED,
            mint: MINT,
            _all: [{ index: 0, programId: TOKEN_PROGRAM, name: 'spl_token.approve' }],
          },
        }),
      ),
    );

    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ delegate: FRESH_DELEGATE });
  });

  it('carries a dedupe key scoped to delegate, mint and severity', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_dedupe',
          approvals: [{ delegate: FRESH_DELEGATE, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result?.dedupeKey).toBe(`token_approval:${FRESH_DELEGATE}:${MINT}:critical`);
  });

  it('falls back to an "unknown" mint segment in the dedupe key', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_dedupe_no_mint',
          approvals: [{ delegate: FRESH_DELEGATE, amount: UNLIMITED, mint: undefined }],
        }),
      ),
    );

    // approvalEntry only omits the key when explicitly passed undefined —
    // which is how the parser leaves it when meta had no balance for the ATA.
    expect(result?.dedupeKey).toBe(`token_approval:${FRESH_DELEGATE}:unknown:critical`);
    expect(result?.payload).not.toHaveProperty('mint');
  });
});

describe('token_approval_anomaly — silence', () => {
  it('stays silent for a bounded approval to a familiar delegate', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_known_bounded',
          approvals: [{ delegate: KNOWN_DELEGATE, amount: '3000000' }],
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('ignores a transaction with no approvals at all', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_plain_swap',
          instructionName: 'jupiter.swap',
          parsedArgs: {
            inAmount: '100',
            _all: [{ index: 0, programId: JUPITER_PROGRAM, name: 'jupiter.swap' }],
          },
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('ignores an amount-zero approval — that is a revoke, not an exposure', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_zero',
          approvals: [{ delegate: FRESH_DELEGATE, amount: '0' }],
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('ignores a self-delegation', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_self',
          approvals: [{ delegate: OWNER, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('ignores an approval in a failed transaction', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_failed',
          approvals: [{ delegate: FRESH_DELEGATE, amount: UNLIMITED }],
          success: false,
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('ignores malformed approval entries', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({
          signature: 'sig_malformed',
          parsedArgs: {
            _approvals: [
              { delegate: FRESH_DELEGATE }, // no amount
              { amount: UNLIMITED }, // no delegate
              { delegate: FRESH_DELEGATE, amount: 'not-a-number' },
              'garbage',
              null,
            ],
          },
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('handles a null parsedArgs without throwing', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        agentId,
        snapshot({ signature: 'sig_null_args', parsedArgs: null, instructionName: null }),
      ),
    );

    expect(result).toBeNull();
  });
});

describe('token_approval_anomaly — cold start', () => {
  it('abstains on a bounded approval from an agent with no history', async () => {
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        coldAgentId,
        snapshot({
          signature: 'sig_cold_bounded',
          approvals: [{ delegate: FRESH_DELEGATE, amount: '1000' }],
        }),
      ),
    );

    expect(result).toBeNull();
  });

  it('still fires on an unlimited approval from an agent with no history', async () => {
    // u64::MAX needs no baseline to be reckless — and a wallet drained on day
    // one is exactly the case a cold-start abstain would have missed.
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        coldAgentId,
        snapshot({
          signature: 'sig_cold_unlimited',
          approvals: [{ delegate: FRESH_DELEGATE, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ coldStart: true, unlimited: true });
  });
});

describe('token_approval_anomaly — isolation', () => {
  it('does not treat another agent approvals as this agent history', async () => {
    // The known delegate is familiar to `agentId` only. A second agent
    // approving it must still be judged as first contact.
    const result = await tokenApprovalRule.evaluate(
      ctxFor(
        coldAgentId,
        snapshot({
          signature: 'sig_isolation',
          approvals: [{ delegate: KNOWN_DELEGATE, amount: UNLIMITED }],
        }),
      ),
    );

    expect(result).not.toBeNull();
    expect(result?.payload).toMatchObject({ delegate: KNOWN_DELEGATE, coldStart: true });
  });
});
