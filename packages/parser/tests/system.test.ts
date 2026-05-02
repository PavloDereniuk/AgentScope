/**
 * Tests for the System Program instruction parser.
 *
 * Builds minimal hand-rolled VersionedTransactionResponse fixtures
 * the same way dispatcher.test.ts does — these focus on the
 * discriminator → name + args mapping rather than real on-chain
 * captures, since the layouts are stable Solana SDK formats.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _clearParserRegistry } from '../src/dispatcher';
import { parseTransaction, registerParser, systemParser } from '../src/index';
import type { ParseInput } from '../src/types';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const OWNER = 'AgentOwnerPubkey0000000000000000000000000';
const RECIPIENT = 'RecipientPubkey00000000000000000000000000';
const NEW_ACCT = 'NewAccountPubkey0000000000000000000000000';

const fakeKey = (s: string) => ({ toBase58: () => s });

function makeFixture(opts: {
  accountKeys: string[];
  instructions: { programIdIndex: number; accountIndexes: number[]; data: Uint8Array }[];
  preLamports: number[];
  postLamports: number[];
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
      fee: 5000,
      preBalances: opts.preLamports,
      postBalances: opts.postLamports,
      logMessages: [],
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [],
      postTokenBalances: [],
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

/** Build a Transfer instruction: u32 disc=2, u64 lamports LE. */
function transferIxData(lamports: bigint): Uint8Array {
  const buf = new Uint8Array(12);
  buf[0] = 2;
  for (let i = 0; i < 8; i++) {
    buf[4 + i] = Number((lamports >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

/** Build a CreateAccount instruction: u32 disc=0, u64 lamports, u64 space, 32-byte owner. */
function createAccountIxData(lamports: bigint, space: bigint): Uint8Array {
  const buf = new Uint8Array(4 + 8 + 8 + 32);
  buf[0] = 0;
  for (let i = 0; i < 8; i++) {
    buf[4 + i] = Number((lamports >> BigInt(i * 8)) & 0xffn);
    buf[12 + i] = Number((space >> BigInt(i * 8)) & 0xffn);
  }
  return buf;
}

beforeEach(() => {
  _clearParserRegistry();
  registerParser(systemParser);
});

describe('systemParser.transfer', () => {
  it('decodes Transfer with from/to/lamports', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, RECIPIENT, SYSTEM_PROGRAM],
        instructions: [
          {
            programIdIndex: 2,
            accountIndexes: [0, 1],
            data: transferIxData(1_000_000n),
          },
        ],
        preLamports: [10_000_000, 0, 1],
        postLamports: [8_995_000, 1_000_000, 1],
      }),
    );

    expect(result.instructions).toHaveLength(1);
    const ix = result.instructions[0];
    expect(ix?.name).toBe('system.transfer');
    expect(ix?.args).toMatchObject({
      from: OWNER,
      to: RECIPIENT,
      lamports: '1000000',
    });
  });
});

describe('systemParser.create_account', () => {
  it('decodes CreateAccount with from/newAccount/lamports/space', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, NEW_ACCT, SYSTEM_PROGRAM],
        instructions: [
          {
            programIdIndex: 2,
            accountIndexes: [0, 1],
            data: createAccountIxData(2_000_000n, 165n),
          },
        ],
        preLamports: [10_000_000, 0, 1],
        postLamports: [7_995_000, 2_000_000, 1],
      }),
    );

    const ix = result.instructions[0];
    expect(ix?.name).toBe('system.create_account');
    expect(ix?.args).toMatchObject({
      from: OWNER,
      newAccount: NEW_ACCT,
      lamports: '2000000',
      space: '165',
    });
  });
});

describe('systemParser unknown discriminators', () => {
  it('returns system.unknown for non-decoded variants (e.g. nonce ops)', () => {
    // disc = 4 (AdvanceNonceAccount) — not in the decoder's switch
    const data = new Uint8Array([4, 0, 0, 0]);
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, SYSTEM_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data }],
        preLamports: [1, 1],
        postLamports: [1, 1],
      }),
    );
    expect(result.instructions[0]?.name).toBe('system.unknown');
  });

  it('returns system.unknown when discriminator bytes are truncated', () => {
    const result = parseTransaction(
      makeFixture({
        accountKeys: [OWNER, SYSTEM_PROGRAM],
        instructions: [{ programIdIndex: 1, accountIndexes: [0], data: new Uint8Array([2]) }],
        preLamports: [1, 1],
        postLamports: [1, 1],
      }),
    );
    expect(result.instructions[0]?.name).toBe('system.unknown');
  });
});
