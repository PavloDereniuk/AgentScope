/**
 * Unit tests for `createSlotNeighbourFetcher` (A.1 Phase 2).
 *
 * Mocks @solana/web3.js Connection.getBlock and verifies:
 *   - happy-path projection (sig / fee / programIds / success)
 *   - error swallowing (RPC throws → empty array, not propagated)
 *   - per-slot caching (same slot → one RPC call)
 *   - in-flight coalescing (overlapping calls → one RPC promise)
 *   - failed-tx success flag, missing-key safety
 */

import type { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createSlotNeighbourFetcher } from '../src/slot-neighbours';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
};

function pk(base58: string): PublicKey {
  // Minimal duck-typed PublicKey — slot-neighbours only calls toBase58().
  return { toBase58: () => base58 } as unknown as PublicKey;
}

interface FakeBlockTx {
  meta: {
    fee: number;
    err: null | Record<string, unknown>;
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      staticAccountKeys?: PublicKey[];
      accountKeys?: PublicKey[];
      compiledInstructions?: Array<{
        programIdIndex: number;
        accountKeyIndexes: number[];
        data: Uint8Array;
      }>;
      instructions?: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    };
  };
}

function makeBlock(txs: FakeBlockTx[]): { transactions: FakeBlockTx[] } {
  return { transactions: txs };
}

const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM = '11111111111111111111111111111111';

function makeMockConnection(getBlockImpl: (slot: number) => Promise<unknown>) {
  return {
    getBlock: vi.fn(getBlockImpl),
    // Other Connection methods are not exercised by the fetcher.
  } as unknown as Parameters<typeof createSlotNeighbourFetcher>[0]['connection'] & {
    getBlock: ReturnType<typeof vi.fn>;
  };
}

describe('createSlotNeighbourFetcher', () => {
  it('projects each tx to { signature, feeLamports, programIds, success }', async () => {
    const connection = makeMockConnection(async () =>
      makeBlock([
        {
          meta: { fee: 50000, err: null },
          transaction: {
            signatures: ['sig-jupiter'],
            message: {
              staticAccountKeys: [pk(JUPITER), pk('user-key')],
              compiledInstructions: [
                { programIdIndex: 0, accountKeyIndexes: [1], data: new Uint8Array() },
              ],
            },
          },
        },
        {
          meta: { fee: 5000, err: { InstructionError: [] } }, // failed
          transaction: {
            signatures: ['sig-system'],
            message: {
              staticAccountKeys: [pk(SYSTEM), pk('user-key-2')],
              compiledInstructions: [
                { programIdIndex: 0, accountKeyIndexes: [1], data: new Uint8Array() },
              ],
            },
          },
        },
      ]),
    );

    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });
    const result = await fetcher(300_000_000);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      signature: 'sig-jupiter',
      feeLamports: 50000,
      programIds: [JUPITER],
      success: true,
    });
    expect(result[1]).toEqual({
      signature: 'sig-system',
      feeLamports: 5000,
      programIds: [SYSTEM],
      success: false,
    });
  });

  it('returns empty array and swallows RPC errors (defensive)', async () => {
    const connection = makeMockConnection(async () => {
      throw new Error('RPC unavailable');
    });

    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });
    const result = await fetcher(300_000_000);

    expect(result).toEqual([]);
  });

  it('caches results per slot — second call inside TTL hits memory, not RPC', async () => {
    const connection = makeMockConnection(async () => makeBlock([]));
    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });

    await fetcher(300_000_000);
    await fetcher(300_000_000);
    await fetcher(300_000_001); // different slot — must hit RPC

    expect(connection.getBlock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls for the same slot into a single RPC promise', async () => {
    let resolveBlock!: (b: { transactions: FakeBlockTx[] }) => void;
    const connection = makeMockConnection(
      () =>
        new Promise((resolve) => {
          resolveBlock = resolve;
        }),
    );
    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });

    const promiseA = fetcher(300_000_000);
    const promiseB = fetcher(300_000_000);
    const promiseC = fetcher(300_000_000);

    // All three should be observing the same in-flight RPC call.
    expect(connection.getBlock).toHaveBeenCalledTimes(1);

    resolveBlock(makeBlock([]));
    const [a, b, c] = await Promise.all([promiseA, promiseB, promiseC]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(c).toEqual([]);
  });

  it('returns [] when getBlock resolves to null (block skipped / pruned)', async () => {
    const connection = makeMockConnection(async () => null);
    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });

    expect(await fetcher(300_000_000)).toEqual([]);
  });

  it('handles ALT-loaded addresses for v0 transactions', async () => {
    const connection = makeMockConnection(async () =>
      makeBlock([
        {
          meta: {
            fee: 8000,
            err: null,
            loadedAddresses: { writable: [pk(JUPITER)], readonly: [] },
          },
          transaction: {
            signatures: ['sig-v0'],
            message: {
              staticAccountKeys: [pk('user-signer')],
              // programIdIndex=1 → first ALT-loaded address = JUPITER
              compiledInstructions: [
                { programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array() },
              ],
            },
          },
        },
      ]),
    );

    const fetcher = createSlotNeighbourFetcher({ connection, logger: silentLogger });
    const [tx] = await fetcher(300_000_000);
    expect(tx?.programIds).toContain(JUPITER);
  });
});
