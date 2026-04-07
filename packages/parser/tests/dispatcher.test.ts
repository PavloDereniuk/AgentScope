/**
 * Smoke tests for the parseTransaction dispatcher.
 *
 * These tests use a hand-rolled VersionedTransactionResponse-like
 * fixture instead of a real on-chain capture — that lets us cover
 * the dispatcher's branches (registry hit, miss, malformed input,
 * delta computation) without depending on Helius or fixtures yet.
 *
 * Real-tx fixtures land in tasks 2.3-2.4 for the Jupiter and Kamino
 * parsers themselves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _clearParserRegistry, _registeredProgramIds } from '../src/dispatcher';
import { parseTransaction, registerParser } from '../src/index';
import type { ParseInput, ProgramParser } from '../src/types';

// Fake pubkey strings — the dispatcher only ever calls .toBase58() on
// the message account keys, so we skip PublicKey validation and pass
// duck-typed objects instead. Real-tx fixtures (2.3, 2.4) will exercise
// the parser modules with actual base58 keys.
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TEST_PROGRAM = 'TestProgram1111111111111111111111111111111';
const OWNER = 'AgentOwnerPubkey0000000000000000000000000';
const OTHER = 'OtherWalletPubkey00000000000000000000000';
const MINT = 'TestMintPubkey0000000000000000000000000000';

const fakeKey = (s: string) => ({ toBase58: () => s });

beforeEach(() => {
  _clearParserRegistry();
});

/**
 * Build a minimal v0-message-shaped tx response with the fields the
 * dispatcher actually reads. We bypass strict @solana/web3.js types
 * via `unknown` casts because constructing a real VersionedMessage
 * here would dwarf the test.
 */
function makeFixture(opts: {
  accountKeys: string[];
  instructions: { programIdIndex: number; accountIndexes: number[]; data: Uint8Array }[];
  preLamports: number[];
  postLamports: number[];
  fee?: number;
  logs?: string[];
  preTokenBalances?: { owner: string; mint: string; amount: string; decimals: number }[];
  postTokenBalances?: { owner: string; mint: string; amount: string; decimals: number }[];
}): ParseInput {
  const tx = {
    transaction: {
      message: {
        staticAccountKeys: opts.accountKeys.map(fakeKey),
        compiledInstructions: opts.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: ix.accountIndexes,
          data: ix.data,
        })),
      },
    },
    meta: {
      err: null,
      fee: opts.fee ?? 5000,
      preBalances: opts.preLamports,
      postBalances: opts.postLamports,
      logMessages: opts.logs ?? [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: (opts.preTokenBalances ?? []).map((b, i) => ({
        accountIndex: i,
        owner: b.owner,
        mint: b.mint,
        programId: SYSTEM_PROGRAM,
        uiTokenAmount: { amount: b.amount, decimals: b.decimals, uiAmount: 0, uiAmountString: '0' },
      })),
      postTokenBalances: (opts.postTokenBalances ?? []).map((b, i) => ({
        accountIndex: i,
        owner: b.owner,
        mint: b.mint,
        programId: SYSTEM_PROGRAM,
        uiTokenAmount: { amount: b.amount, decimals: b.decimals, uiAmount: 0, uiAmountString: '0' },
      })),
    },
  } as unknown as ParseInput['transaction'];

  return {
    signature: 'sigtest123' as ParseInput['signature'],
    slot: 100,
    blockTime: '2026-04-07T12:00:00.000Z' as ParseInput['blockTime'],
    ownerPubkey: OWNER as ParseInput['ownerPubkey'],
    transaction: tx,
  };
}

// ─── Empty registry ────────────────────────────────────────────────────────

describe('parseTransaction with empty registry', () => {
  it('returns a valid ParsedTx with unknown instruction names', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, SYSTEM_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data: new Uint8Array([1, 2, 3]) }],
        preLamports: [1_000_000_000, 1],
        postLamports: [995_000_000, 1],
      }),
    );

    expect(result.signature).toBe('sigtest123');
    expect(result.slot).toBe(100);
    expect(result.success).toBe(true);
    expect(result.feeLamports).toBe(5000);
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.name).toBe('1111.unknown');
    expect(result.instructions[0]?.programId).toBe(SYSTEM_PROGRAM);
  });

  it('computes negative SOL delta for the owner', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER],
        instructions: [],
        preLamports: [2_000_000_000],
        postLamports: [1_500_000_000],
      }),
    );

    expect(result.solDelta).toBe('-0.500000000');
  });

  it('returns 0 SOL delta when owner is not in account keys', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OTHER],
        instructions: [],
        preLamports: [1_000_000_000],
        postLamports: [1_000_000_000],
      }),
    );

    expect(result.solDelta).toBe('0');
  });
});

// ─── Token deltas ──────────────────────────────────────────────────────────

describe('parseTransaction token deltas', () => {
  it('computes net token delta for owner across pre/post', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, MINT],
        instructions: [],
        preLamports: [1_000_000_000, 1],
        postLamports: [999_995_000, 1],
        preTokenBalances: [{ owner: OWNER, mint: MINT, amount: '1000000', decimals: 6 }],
        postTokenBalances: [{ owner: OWNER, mint: MINT, amount: '1500000', decimals: 6 }],
      }),
    );

    expect(result.tokenDeltas).toHaveLength(1);
    expect(result.tokenDeltas[0]?.mint).toBe(MINT);
    expect(result.tokenDeltas[0]?.delta).toBe('500000');
    expect(result.tokenDeltas[0]?.decimals).toBe(6);
  });

  it('skips zero-delta entries', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, MINT],
        instructions: [],
        preLamports: [1, 1],
        postLamports: [1, 1],
        preTokenBalances: [{ owner: OWNER, mint: MINT, amount: '500', decimals: 6 }],
        postTokenBalances: [{ owner: OWNER, mint: MINT, amount: '500', decimals: 6 }],
      }),
    );

    expect(result.tokenDeltas).toHaveLength(0);
  });

  it('ignores token balances owned by other wallets', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, OTHER, MINT],
        instructions: [],
        preLamports: [1, 1, 1],
        postLamports: [1, 1, 1],
        preTokenBalances: [{ owner: OTHER, mint: MINT, amount: '0', decimals: 6 }],
        postTokenBalances: [{ owner: OTHER, mint: MINT, amount: '999999', decimals: 6 }],
      }),
    );

    expect(result.tokenDeltas).toHaveLength(0);
  });
});

// ─── Registry hit ──────────────────────────────────────────────────────────

describe('parseTransaction with registered parser', () => {
  it('routes instructions through the matching parser', () => {
    const fakeParser: ProgramParser = {
      programId: TEST_PROGRAM as ProgramParser['programId'],
      namespace: 'test',
      decode: (data) => {
        if (data[0] === 0x01) return { name: 'doStuff', args: { value: 42 } };
        return null;
      },
    };
    registerParser(fakeParser);
    expect(_registeredProgramIds()).toContain(TEST_PROGRAM);

    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, TEST_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data: new Uint8Array([0x01]) }],
        preLamports: [1, 1],
        postLamports: [1, 1],
      }),
    );

    expect(result.instructions[0]?.name).toBe('test.doStuff');
    expect(result.instructions[0]?.args).toEqual({ value: 42 });
  });

  it('falls back to <namespace>.unknown when decoder returns null', () => {
    const fakeParser: ProgramParser = {
      programId: TEST_PROGRAM as ProgramParser['programId'],
      namespace: 'test',
      decode: () => null,
    };
    registerParser(fakeParser);

    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, TEST_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data: new Uint8Array([0xff]) }],
        preLamports: [1, 1],
        postLamports: [1, 1],
      }),
    );

    expect(result.instructions[0]?.name).toBe('test.unknown');
  });
});

// ─── Failed transactions ───────────────────────────────────────────────────

describe('parseTransaction failed tx', () => {
  it('marks success=false when meta.err is set', () => {
    const fixture = makeFixture({
      accountKeys: [OWNER],
      instructions: [],
      preLamports: [1],
      postLamports: [1],
    });
    // mutate meta.err
    (fixture.transaction as unknown as { meta: { err: unknown } }).meta.err = {
      InstructionError: [0, 'Custom'],
    };

    const result = parseTransaction(fixture);
    expect(result.success).toBe(false);
  });
});
