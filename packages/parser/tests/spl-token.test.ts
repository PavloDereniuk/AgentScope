/**
 * Tests for the SPL Token instruction parser (A.10).
 *
 * Hand-rolled fixtures in the same style as system.test.ts — the SPL Token
 * layouts are stable, byte-fixed formats from solana-program-library, so what
 * matters here is the discriminator → name + accounts mapping, plus the mint
 * recovery that only the unchecked variants need.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _clearParserRegistry } from '../src/dispatcher';
import { parseTransaction, registerParser, splTokenParser, token2022Parser } from '../src/index';
import type { ParseInput } from '../src/types';

const TOKEN_PROGRAM = 'TokenkegQfZFAhUJMRNbSL2vM5qTgaK5TxwQnEKL7aP';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const OWNER = 'AgentOwnerPubkey0000000000000000000000000';
const SOURCE_ATA = 'SourceTokenAccount000000000000000000000';
const DEST_ATA = 'DestTokenAccount00000000000000000000000';
const DELEGATE = 'DelegatePubkey000000000000000000000000000';
const MINT = 'MintPubkey0000000000000000000000000000000';

/** u64::MAX — the "unlimited approval" the token_approval_anomaly rule hunts. */
const U64_MAX = 18_446_744_073_709_551_615n;

const fakeKey = (s: string) => ({ toBase58: () => s });

function makeFixture(opts: {
  accountKeys: string[];
  instructions: { programIdIndex: number; accountIndexes: number[]; data: Uint8Array }[];
  /** Token balances, used by the dispatcher to build the account → mint map. */
  tokenBalances?: { accountIndex: number; mint: string; owner: string }[];
}): ParseInput {
  const balances = (opts.tokenBalances ?? []).map((b) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: { amount: '0', decimals: 6 },
  }));

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
      fee: 5000,
      preBalances: opts.accountKeys.map(() => 1_000_000),
      postBalances: opts.accountKeys.map(() => 1_000_000),
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: balances,
      postTokenBalances: balances,
    },
  } as unknown as ParseInput['transaction'];

  return {
    signature: 'sigtest123' as ParseInput['signature'],
    slot: 100,
    blockTime: '2026-08-11T12:00:00.000Z' as ParseInput['blockTime'],
    ownerPubkey: OWNER as ParseInput['ownerPubkey'],
    transaction: tx,
  };
}

/** u8 discriminator + u64 amount LE (Transfer=3, Approve=4, MintTo=7, Burn=8). */
function amountIx(disc: number, amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = disc;
  for (let i = 0; i < 8; i++) buf[1 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
  return buf;
}

/** u8 discriminator + u64 amount LE + u8 decimals (TransferChecked=12, ApproveChecked=13). */
function checkedIx(disc: number, amount: bigint, decimals: number): Uint8Array {
  const buf = new Uint8Array(10);
  buf.set(amountIx(disc, amount));
  buf[9] = decimals;
  return buf;
}

beforeEach(() => {
  _clearParserRegistry();
  registerParser(splTokenParser);
  registerParser(token2022Parser);
});

describe('splTokenParser.approve', () => {
  it('decodes Approve with source/delegate/owner/amount', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [
          { programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(4, 1_500_000n) },
        ],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('spl_token.approve');
    expect(ix?.args).toMatchObject({
      source: SOURCE_ATA,
      delegate: DELEGATE,
      owner: OWNER,
      amount: '1500000',
    });
  });

  it('recovers the mint from the source token account when the layout omits it', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(4, 42n) }],
        tokenBalances: [{ accountIndex: 0, mint: MINT, owner: OWNER }],
      }),
    );

    expect(result.instructions[0]?.args).toMatchObject({ mint: MINT, amount: '42' });
  });

  it('omits the mint key entirely when the token account is not in meta', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(4, 42n) }],
      }),
    );

    expect(result.instructions[0]?.args).not.toHaveProperty('mint');
  });

  it('preserves u64::MAX exactly — the unlimited-approval fingerprint', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [
          { programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(4, U64_MAX) },
        ],
      }),
    );

    // Float parsing would round this to 18446744073709552000 — the exact
    // string is what lets the detector recognise an unlimited approval.
    expect(result.instructions[0]?.args).toMatchObject({ amount: '18446744073709551615' });
  });
});

describe('splTokenParser.approve_checked', () => {
  it('decodes ApproveChecked with the explicit mint account and decimals', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, MINT, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [
          { programIdIndex: 4, accountIndexes: [0, 1, 2, 3], data: checkedIx(13, 250n, 6) },
        ],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('spl_token.approve_checked');
    expect(ix?.args).toMatchObject({
      source: SOURCE_ATA,
      mint: MINT,
      delegate: DELEGATE,
      owner: OWNER,
      amount: '250',
      decimals: 6,
    });
  });
});

describe('splTokenParser.revoke', () => {
  it('decodes Revoke with source/owner and no amount', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: new Uint8Array([5]) }],
        tokenBalances: [{ accountIndex: 0, mint: MINT, owner: OWNER }],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('spl_token.revoke');
    expect(ix?.args).toMatchObject({ source: SOURCE_ATA, owner: OWNER, mint: MINT });
    expect(ix?.args).not.toHaveProperty('amount');
  });
});

describe('splTokenParser.transfer', () => {
  it('decodes Transfer with source/destination/authority/amount', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DEST_ATA, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(3, 7_000n) }],
        tokenBalances: [{ accountIndex: 0, mint: MINT, owner: OWNER }],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('spl_token.transfer');
    expect(ix?.args).toMatchObject({
      source: SOURCE_ATA,
      destination: DEST_ATA,
      authority: OWNER,
      amount: '7000',
      mint: MINT,
    });
  });

  it('decodes TransferChecked with the explicit mint account', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, MINT, DEST_ATA, OWNER, TOKEN_PROGRAM],
        instructions: [
          { programIdIndex: 4, accountIndexes: [0, 1, 2, 3], data: checkedIx(12, 9n, 9) },
        ],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('spl_token.transfer_checked');
    expect(ix?.args).toMatchObject({
      source: SOURCE_ATA,
      mint: MINT,
      destination: DEST_ATA,
      authority: OWNER,
      amount: '9',
      decimals: 9,
    });
  });
});

describe('splTokenParser on Token-2022', () => {
  it('decodes the shared core layout under the Token-2022 program id', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_2022_PROGRAM],
        instructions: [{ programIdIndex: 3, accountIndexes: [0, 1, 2], data: amountIx(4, 1n) }],
      }),
    );

    const ix = result.instructions[0];
    // Same namespace on purpose: the detector matches one instruction name and
    // reads the program id from the tx outline when it needs to tell them apart.
    expect(ix?.name).toBe('spl_token.approve');
    expect(ix?.programId).toBe(TOKEN_2022_PROGRAM);
  });
});

describe('splTokenParser unknown discriminators', () => {
  it('returns spl_token.unknown for instructions outside the decoded set', () => {
    // disc = 7 (MintTo) — a real instruction we deliberately do not decode.
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: amountIx(7, 100n) }],
      }),
    );

    expect(result.instructions[0]?.name).toBe('spl_token.unknown');
  });

  it('returns spl_token.unknown for Token-2022 extension instructions', () => {
    // disc = 43 (TransferFeeExtension) — Token-2022 only, nested sub-layout.
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, OWNER, TOKEN_2022_PROGRAM],
        instructions: [
          { programIdIndex: 2, accountIndexes: [0, 1], data: new Uint8Array([43, 1]) },
        ],
      }),
    );

    expect(result.instructions[0]?.name).toBe('spl_token.unknown');
  });

  it('returns spl_token.unknown on empty instruction data', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, OWNER, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: new Uint8Array([]) }],
      }),
    );

    expect(result.instructions[0]?.name).toBe('spl_token.unknown');
  });

  it('returns spl_token.unknown when the amount bytes are truncated', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, DELEGATE, OWNER, TOKEN_PROGRAM],
        instructions: [
          { programIdIndex: 3, accountIndexes: [0, 1, 2], data: new Uint8Array([4, 0, 0]) },
        ],
      }),
    );

    expect(result.instructions[0]?.name).toBe('spl_token.unknown');
  });

  it('returns spl_token.unknown when Approve is missing its delegate account', () => {
    // A drainer cannot hide behind a malformed account list: no delegate to
    // report means the instruction is not usable evidence, not a silent pass.
    const result = parseTransaction(
      makeFixture({
        accountKeys: [SOURCE_ATA, TOKEN_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data: amountIx(4, 5n) }],
      }),
    );

    expect(result.instructions[0]?.name).toBe('spl_token.unknown');
  });
});
