/**
 * Unit tests for `createBalanceFetcher` (A.2 single-wallet + E.1 batch prime).
 *
 * Mocks @solana/web3.js Connection and verifies:
 *   fetch():
 *     - happy-path lamports → SOL conversion
 *     - per-wallet caching (same wallet → one RPC call within TTL)
 *     - in-flight coalescing (overlapping calls → one RPC promise)
 *     - RPC error swallowing (throws → null, not propagated)
 *     - malformed pubkey swallowing (PublicKey ctor throws → null)
 *     - TTL expiry triggers a fresh RPC
 *   primeBalances():
 *     - one getMultipleAccounts call serves N wallets; reads hit cache (0 getBalance)
 *     - chunks at 100 keys per call
 *     - missing account (null entry) → 0 SOL (real empty-wallet signal)
 *     - RPC error → null per wallet (abstain), no per-wallet getBalance fallback
 *     - malformed pubkey skipped from batch, cached null
 *     - dedupes repeated wallets into the batch
 */

import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createBalanceFetcher } from '../src/balance-fetcher';

const silentLogger = { warn: () => {} };

const VALID_WALLET = 'AGZ1JN6mFV4hyTfBwGZc81H1J9hSHt4HZ8KuYpDJSk7H';
const VALID_WALLET_2 = 'So11111111111111111111111111111111111111112';

type GetBalanceFn = (pk: PublicKey) => Promise<number>;
type GetMultiFn = (pks: PublicKey[]) => Promise<Array<AccountInfo<Buffer> | null>>;

function makeConnection(parts: {
  getBalance?: GetBalanceFn;
  getMultipleAccountsInfo?: GetMultiFn;
}): Connection {
  return parts as unknown as Connection;
}

/** Minimal AccountInfo with just the lamports field the fetcher reads. */
function acct(lamports: number): AccountInfo<Buffer> {
  return { lamports } as unknown as AccountInfo<Buffer>;
}

describe('createBalanceFetcher — fetch()', () => {
  it('converts lamports to SOL', async () => {
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: async () => 1_500_000_000 }),
      logger: silentLogger,
    });
    expect(await fetch(VALID_WALLET)).toBe(1.5);
  });

  it('returns zero for an empty wallet', async () => {
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: async () => 0 }),
      logger: silentLogger,
    });
    expect(await fetch(VALID_WALLET)).toBe(0);
  });

  it('caches per-wallet — second call within TTL hits the cache', async () => {
    const rpc = vi.fn().mockResolvedValue(500_000_000);
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: rpc }),
      logger: silentLogger,
    });
    await fetch(VALID_WALLET);
    await fetch(VALID_WALLET);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent calls for the same wallet', async () => {
    let resolve: (v: number) => void = () => undefined;
    const rpc = vi.fn(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: rpc }),
      logger: silentLogger,
    });
    const p1 = fetch(VALID_WALLET);
    const p2 = fetch(VALID_WALLET);
    resolve(2_000_000_000);
    expect(await p1).toBe(2);
    expect(await p2).toBe(2);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('returns null when the RPC throws (does not propagate)', async () => {
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({
        getBalance: async () => {
          throw new Error('rpc down');
        },
      }),
      logger: silentLogger,
    });
    expect(await fetch(VALID_WALLET)).toBeNull();
  });

  it('returns null for a malformed pubkey (PublicKey ctor throws)', async () => {
    const rpc = vi.fn();
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: rpc }),
      logger: silentLogger,
    });
    expect(await fetch('not-a-pubkey')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('re-fetches after TTL expires', async () => {
    const rpc = vi.fn().mockResolvedValue(1_000_000_000);
    const { fetch } = createBalanceFetcher({
      connection: makeConnection({ getBalance: rpc }),
      logger: silentLogger,
      cacheTtlMs: 10,
    });
    await fetch(VALID_WALLET);
    await new Promise((r) => setTimeout(r, 20));
    await fetch(VALID_WALLET);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('createBalanceFetcher — primeBalances() (E.1)', () => {
  it('primes many wallets in one getMultipleAccounts call; reads hit the cache', async () => {
    const getMulti = vi.fn<GetMultiFn>(async (pks) => pks.map((_, i) => acct((i + 1) * 1e9)));
    const getBalance = vi.fn<GetBalanceFn>();
    const { fetch, primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getBalance, getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
    });

    await primeBalances([VALID_WALLET, VALID_WALLET_2]);

    expect(getMulti).toHaveBeenCalledTimes(1);
    expect(await fetch(VALID_WALLET)).toBe(1);
    expect(await fetch(VALID_WALLET_2)).toBe(2);
    // The whole point of E.1: no per-agent getBalance fallback after a prime.
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('chunks at 100 keys per getMultipleAccounts call', async () => {
    // 100 distinct base58 wallets is awkward to hand-author; reuse two valid
    // pubkeys is not enough (dedupe collapses them). Instead drive chunking
    // off a generated list of valid keys by deriving from a seed buffer.
    const wallets = makeManyWallets(150);
    const getMulti = vi.fn<GetMultiFn>(async (pks) => pks.map(() => acct(1e9)));
    const { primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
      maxCacheSize: 1000,
    });

    await primeBalances(wallets);

    expect(getMulti).toHaveBeenCalledTimes(2); // 100 + 50
    expect(getMulti.mock.calls[0]?.[0]).toHaveLength(100);
    expect(getMulti.mock.calls[1]?.[0]).toHaveLength(50);
  });

  it('maps a missing account (null entry) to 0 SOL — a real empty wallet', async () => {
    const getMulti = vi.fn<GetMultiFn>(async () => [null]);
    const { fetch, primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
    });
    await primeBalances([VALID_WALLET]);
    expect(await fetch(VALID_WALLET)).toBe(0);
  });

  it('caches null (abstain) per wallet on batch RPC error — no getBalance fallback', async () => {
    const getBalance = vi.fn<GetBalanceFn>();
    const getMulti = vi.fn<GetMultiFn>(async () => {
      throw new Error('rpc down');
    });
    const { fetch, primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getBalance, getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
    });

    await primeBalances([VALID_WALLET, VALID_WALLET_2]);

    expect(await fetch(VALID_WALLET)).toBeNull();
    expect(await fetch(VALID_WALLET_2)).toBeNull();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it('skips a malformed pubkey from the batch and caches it null', async () => {
    const getMulti = vi.fn<GetMultiFn>(async (pks) => pks.map(() => acct(3e9)));
    const { fetch, primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
    });

    await primeBalances(['not-a-pubkey', VALID_WALLET]);

    // Only the valid wallet reached the batch.
    expect(getMulti.mock.calls[0]?.[0]).toHaveLength(1);
    expect(await fetch(VALID_WALLET)).toBe(3);
    expect(await fetch('not-a-pubkey')).toBeNull();
  });

  it('dedupes repeated wallets into a single batch entry', async () => {
    const getMulti = vi.fn<GetMultiFn>(async (pks) => pks.map(() => acct(1e9)));
    const { primeBalances } = createBalanceFetcher({
      connection: makeConnection({ getMultipleAccountsInfo: getMulti }),
      logger: silentLogger,
    });

    await primeBalances([VALID_WALLET, VALID_WALLET, VALID_WALLET]);

    expect(getMulti.mock.calls[0]?.[0]).toHaveLength(1);
  });
});

/**
 * Build N valid base58 ed25519 pubkeys by deriving from sequential seeds.
 * PublicKey accepts any 32-byte buffer, so we just vary the bytes.
 */
function makeManyWallets(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(32);
    bytes[0] = i & 0xff;
    bytes[1] = (i >> 8) & 0xff;
    out.push(new PublicKey(bytes).toBase58());
  }
  return out;
}
