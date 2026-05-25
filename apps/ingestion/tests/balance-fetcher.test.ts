/**
 * Unit tests for `createBalanceFetcher` (A.2).
 *
 * Mocks @solana/web3.js Connection.getBalance and verifies:
 *   - happy-path lamports → SOL conversion
 *   - per-wallet caching (same wallet → one RPC call within TTL)
 *   - in-flight coalescing (overlapping calls → one RPC promise)
 *   - RPC error swallowing (throws → null, not propagated)
 *   - malformed pubkey swallowing (PublicKey ctor throws → null)
 *   - TTL expiry triggers a fresh RPC
 */

import type { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createBalanceFetcher } from '../src/balance-fetcher';

const silentLogger = { warn: () => {} };

const VALID_WALLET = 'AGZ1JN6mFV4hyTfBwGZc81H1J9hSHt4HZ8KuYpDJSk7H';

function makeConnection(getBalance: (pk: PublicKey) => Promise<number>): Connection {
  return { getBalance } as unknown as Connection;
}

describe('createBalanceFetcher', () => {
  it('converts lamports to SOL', async () => {
    const fetcher = createBalanceFetcher({
      connection: makeConnection(async () => 1_500_000_000),
      logger: silentLogger,
    });
    const balance = await fetcher(VALID_WALLET);
    expect(balance).toBe(1.5);
  });

  it('returns zero for an empty wallet', async () => {
    const fetcher = createBalanceFetcher({
      connection: makeConnection(async () => 0),
      logger: silentLogger,
    });
    expect(await fetcher(VALID_WALLET)).toBe(0);
  });

  it('caches per-wallet — second call within TTL hits the cache', async () => {
    const rpc = vi.fn().mockResolvedValue(500_000_000);
    const fetcher = createBalanceFetcher({
      connection: makeConnection(rpc),
      logger: silentLogger,
    });
    await fetcher(VALID_WALLET);
    await fetcher(VALID_WALLET);
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
    const fetcher = createBalanceFetcher({
      connection: makeConnection(rpc),
      logger: silentLogger,
    });
    const p1 = fetcher(VALID_WALLET);
    const p2 = fetcher(VALID_WALLET);
    resolve(2_000_000_000);
    expect(await p1).toBe(2);
    expect(await p2).toBe(2);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('returns null when the RPC throws (does not propagate)', async () => {
    const fetcher = createBalanceFetcher({
      connection: makeConnection(async () => {
        throw new Error('rpc down');
      }),
      logger: silentLogger,
    });
    expect(await fetcher(VALID_WALLET)).toBeNull();
  });

  it('returns null for a malformed pubkey (PublicKey ctor throws)', async () => {
    const rpc = vi.fn();
    const fetcher = createBalanceFetcher({
      connection: makeConnection(rpc),
      logger: silentLogger,
    });
    const result = await fetcher('not-a-pubkey');
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('re-fetches after TTL expires', async () => {
    const rpc = vi.fn().mockResolvedValue(1_000_000_000);
    const fetcher = createBalanceFetcher({
      connection: makeConnection(rpc),
      logger: silentLogger,
      cacheTtlMs: 10,
    });
    await fetcher(VALID_WALLET);
    await new Promise((r) => setTimeout(r, 20));
    await fetcher(VALID_WALLET);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
