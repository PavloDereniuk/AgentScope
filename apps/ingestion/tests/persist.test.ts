/**
 * Tests for the persistence storage-diet + primary-instruction helpers
 * (E.2 + E.5 + A.10).
 *
 * Pure-helper coverage — no DB, every helper here is side-effect free:
 *   - capRawLogs (E.2): slim/fuller log slice + truncation marker.
 *   - compactInstructionOutline (E.5): drops per-instruction args from `_all`.
 *   - collectApprovals (A.10): SPL approvals kept from anywhere in the tx.
 *   - pickPrimaryInstruction: tier order, incl. the spl_token demotion (A.10).
 */

import { describe, expect, it } from 'vitest';
import {
  RAW_LOGS_LIMIT_FAILURE,
  RAW_LOGS_LIMIT_SUCCESS,
  capRawLogs,
  collectApprovals,
  compactInstructionOutline,
  pickPrimaryInstruction,
} from '../src/persist';

const makeLogs = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i}`);

describe('capRawLogs (E.2)', () => {
  it('returns logs unchanged when at or below the success limit', () => {
    const logs = makeLogs(RAW_LOGS_LIMIT_SUCCESS);
    const out = capRawLogs(logs, true);
    expect(out).toEqual(logs);
  });

  it('returns a fresh array (does not alias the input)', () => {
    const logs = makeLogs(5);
    const out = capRawLogs(logs, true);
    expect(out).not.toBe(logs);
    expect(out).toEqual(logs);
  });

  it('truncates a long success tx to the slim limit + marker', () => {
    const logs = makeLogs(1000);
    const out = capRawLogs(logs, true);
    const half = Math.floor(RAW_LOGS_LIMIT_SUCCESS / 2);
    // head + marker + tail
    expect(out).toHaveLength(half * 2 + 1);
    expect(out[half]).toBe(`…truncated ${1000 - RAW_LOGS_LIMIT_SUCCESS} lines…`);
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 999');
  });

  it('keeps a much larger slice on failure than on success', () => {
    const logs = makeLogs(1000);
    const onSuccess = capRawLogs(logs, true);
    const onFailure = capRawLogs(logs, false);
    expect(onFailure.length).toBeGreaterThan(onSuccess.length);
    const half = Math.floor(RAW_LOGS_LIMIT_FAILURE / 2);
    expect(onFailure).toHaveLength(half * 2 + 1);
    expect(onFailure[half]).toBe(`…truncated ${1000 - RAW_LOGS_LIMIT_FAILURE} lines…`);
  });

  it('preserves head and tail (boundary lines survive truncation)', () => {
    const logs = makeLogs(500);
    const out = capRawLogs(logs, false);
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 499');
  });

  it('does not truncate a failed tx that fits within the failure limit', () => {
    const logs = makeLogs(RAW_LOGS_LIMIT_FAILURE);
    const out = capRawLogs(logs, false);
    expect(out).toEqual(logs);
    expect(out.some((l) => l.includes('truncated'))).toBe(false);
  });

  it('handles an empty log array', () => {
    expect(capRawLogs([], true)).toEqual([]);
    expect(capRawLogs([], false)).toEqual([]);
  });

  it('slims a success tx that a failure tx would have kept in full', () => {
    // A log between the two limits: kept whole on failure, truncated on success.
    const logs = makeLogs(RAW_LOGS_LIMIT_FAILURE);
    expect(capRawLogs(logs, false)).toHaveLength(RAW_LOGS_LIMIT_FAILURE);
    expect(capRawLogs(logs, true).length).toBeLessThan(RAW_LOGS_LIMIT_FAILURE);
  });
});

describe('compactInstructionOutline (E.5)', () => {
  const ix = (index: number, programId: string, name: string, args: Record<string, unknown>) => ({
    index,
    programId,
    name,
    args,
  });

  it('keeps index/programId/name for each instruction', () => {
    const out = compactInstructionOutline([
      ix(0, 'ComputeBudget111111111111111111111111111111', 'unknown', {}),
      ix(1, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'jupiter.swap', { inAmount: '100' }),
    ]);
    expect(out).toEqual([
      { index: 0, programId: 'ComputeBudget111111111111111111111111111111', name: 'unknown' },
      { index: 1, programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'jupiter.swap' },
    ]);
  });

  it('drops per-instruction args (the storage win)', () => {
    const out = compactInstructionOutline([
      ix(0, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'jupiter.route', {
        // A bulky multi-hop route_plan — exactly what used to bloat `_all`.
        routePlan: Array.from({ length: 8 }, (_, i) => ({ swap: i, percent: 12 })),
        inAmount: '1000000000',
        quotedOutAmount: '987654321',
      }),
    ]);
    expect(out[0]).not.toHaveProperty('args');
    expect(Object.keys(out[0] ?? {})).toEqual(['index', 'programId', 'name']);
  });

  it('returns an empty array for a tx with no instructions', () => {
    expect(compactInstructionOutline([])).toEqual([]);
  });
});

// ─── A.10 ───────────────────────────────────────────────────────────────────

const TOKEN_PROGRAM = 'TokenkegQfZFAhUJMRNbSL2vM5qTgaK5TxwQnEKL7aP';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const DELEGATE = 'DelegatePubkey000000000000000000000000000';
const SOURCE_ATA = 'SourceTokenAccount000000000000000000000';
const MINT = 'MintPubkey0000000000000000000000000000000';

const ix = (
  index: number,
  programId: string,
  name: string,
  args: Record<string, unknown> = {},
) => ({
  index,
  programId,
  name,
  args,
});

describe('collectApprovals (A.10)', () => {
  it('keeps an approval that is not the primary instruction', () => {
    // The drainer's shape: something ordinary up front, the approval behind it.
    const out = collectApprovals([
      ix(0, JUPITER_PROGRAM, 'jupiter.swap', { inAmount: '100' }),
      ix(1, TOKEN_PROGRAM, 'spl_token.approve', {
        source: SOURCE_ATA,
        delegate: DELEGATE,
        owner: 'Owner1111111111111111111111111111111111111',
        amount: '18446744073709551615',
        mint: MINT,
      }),
    ]);

    expect(out).toEqual([
      {
        index: 1,
        delegate: DELEGATE,
        amount: '18446744073709551615',
        source: SOURCE_ATA,
        owner: 'Owner1111111111111111111111111111111111111',
        mint: MINT,
        programId: TOKEN_PROGRAM,
      },
    ]);
  });

  it('keeps approve_checked and records the owning token program', () => {
    const out = collectApprovals([
      ix(0, TOKEN_2022_PROGRAM, 'spl_token.approve_checked', {
        source: SOURCE_ATA,
        mint: MINT,
        delegate: DELEGATE,
        owner: 'Owner1111111111111111111111111111111111111',
        amount: '500',
        decimals: 6,
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ amount: '500', programId: TOKEN_2022_PROGRAM });
  });

  it('collects every approval in a multi-approval transaction', () => {
    const approval = (index: number, delegate: string) =>
      ix(index, TOKEN_PROGRAM, 'spl_token.approve', {
        source: SOURCE_ATA,
        delegate,
        owner: 'Owner1111111111111111111111111111111111111',
        amount: '1',
      });
    const out = collectApprovals([approval(0, DELEGATE), approval(1, `${DELEGATE}2`)]);
    expect(out.map((a) => a.delegate)).toEqual([DELEGATE, `${DELEGATE}2`]);
  });

  it('omits the mint key when the parser could not resolve it', () => {
    const out = collectApprovals([
      ix(0, TOKEN_PROGRAM, 'spl_token.approve', {
        source: SOURCE_ATA,
        delegate: DELEGATE,
        owner: 'Owner1111111111111111111111111111111111111',
        amount: '1',
      }),
    ]);
    expect(out[0]).not.toHaveProperty('mint');
  });

  it('ignores transfers, revokes and everything that is not an approval', () => {
    const out = collectApprovals([
      ix(0, TOKEN_PROGRAM, 'spl_token.transfer', { source: SOURCE_ATA, amount: '5' }),
      ix(1, TOKEN_PROGRAM, 'spl_token.revoke', { source: SOURCE_ATA }),
      ix(2, TOKEN_PROGRAM, 'spl_token.unknown'),
      ix(3, JUPITER_PROGRAM, 'jupiter.swap', { delegate: DELEGATE, amount: '1' }),
    ]);
    expect(out).toEqual([]);
  });

  it('skips a half-decoded approval rather than persisting a partial record', () => {
    const out = collectApprovals([
      ix(0, TOKEN_PROGRAM, 'spl_token.approve', { source: SOURCE_ATA, amount: '1' }),
    ]);
    expect(out).toEqual([]);
  });

  it('records the signing owner — a self-delegation is not an anomaly', () => {
    const out = collectApprovals([
      ix(0, TOKEN_PROGRAM, 'spl_token.approve', {
        source: SOURCE_ATA,
        delegate: DELEGATE,
        owner: 'Owner1111111111111111111111111111111111111',
        amount: '1',
      }),
    ]);
    expect(out[0]?.owner).toBe('Owner1111111111111111111111111111111111111');
  });

  it('returns an empty array for a tx with no instructions', () => {
    expect(collectApprovals([])).toEqual([]);
  });
});

describe('pickPrimaryInstruction (A.10 — spl_token demotion)', () => {
  it('keeps the protocol op primary when a token transfer rides along', () => {
    // Regression guard: decoding SPL Token promoted these to tier 1, which
    // would have re-labelled every swap and fed slippage rules the wrong args.
    const primary = pickPrimaryInstruction({
      instructions: [
        ix(0, COMPUTE_BUDGET, 'unknown'),
        ix(1, TOKEN_PROGRAM, 'spl_token.transfer', { amount: '5' }),
        ix(2, JUPITER_PROGRAM, 'jupiter.swap', { inAmount: '100' }),
      ],
    });
    expect(primary?.name).toBe('jupiter.swap');
  });

  it('makes a standalone approval the primary instruction', () => {
    const primary = pickPrimaryInstruction({
      instructions: [
        ix(0, COMPUTE_BUDGET, 'unknown'),
        ix(1, TOKEN_PROGRAM, 'spl_token.approve', { delegate: DELEGATE, amount: '1' }),
      ],
    });
    expect(primary?.name).toBe('spl_token.approve');
  });

  it('prefers a decoded token op over an undecoded instruction', () => {
    const primary = pickPrimaryInstruction({
      instructions: [
        ix(0, 'SomeUnknownProgram11111111111111111111111', 'some.unknown'),
        ix(1, TOKEN_PROGRAM, 'spl_token.approve', { delegate: DELEGATE, amount: '1' }),
      ],
    });
    expect(primary?.name).toBe('spl_token.approve');
  });
});
