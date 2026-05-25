/**
 * Wallet-balance lookup helper (post-MVP roadmap A.2 — low_balance rule).
 *
 * Wraps Helius `Connection.getBalance` with the same defensive shape as
 * the slot-neighbour fetcher (A.1 Phase 2):
 *   1. Per-wallet TTL cache so a future second balance-aware rule (e.g.
 *      rent-floor monitor) shares one RPC per cycle.
 *   2. Concurrent-call coalescing — overlapping requests for the same
 *      wallet return the same in-flight promise.
 *
 * Errors are swallowed (and logged) — the detector treats `null` as
 * "unknown balance" and abstains from alerting. Returning null here
 * preserves that contract during RPC outages so a Helius blip never
 * looks like a fleet-wide bankrupt-wallet event.
 */

import type { BalanceFetcher } from '@agentscope/detector';
import { type Connection, PublicKey } from '@solana/web3.js';

interface CacheEntry {
  at: number;
  /** `null` is a valid cached value — RPC succeeded but wallet not found / invalid. */
  balanceSol: number | null;
}

interface WarnLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface BalanceFetcherOptions {
  connection: Connection;
  logger: WarnLogger;
  /**
   * TTL for cached balances. Defaults to 25s — short of the 60s cron
   * cycle so each cycle sees a fresh reading, while still coalescing
   * any same-cycle reads.
   */
  cacheTtlMs?: number;
  /** Maximum cached wallets. Bounded memory — sub-100 B per entry. */
  maxCacheSize?: number;
}

const DEFAULT_TTL_MS = 25_000;
const DEFAULT_MAX_CACHE = 512;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function createBalanceFetcher(opts: BalanceFetcherOptions): BalanceFetcher {
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const maxSize = opts.maxCacheSize ?? DEFAULT_MAX_CACHE;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<number | null>>();

  function pruneIfNeeded(): void {
    if (cache.size < maxSize) return;
    const dropCount = Math.max(1, Math.floor(maxSize / 8));
    const it = cache.keys();
    for (let i = 0; i < dropCount; i++) {
      const next = it.next();
      if (next.done) break;
      cache.delete(next.value);
    }
  }

  async function fetchBalance(walletPubkey: string): Promise<number | null> {
    try {
      // PublicKey constructor throws on malformed input — wrap in the
      // outer try so a bad agent row turns into a logged null instead of
      // an unhandled rejection inside the cron tick.
      const pk = new PublicKey(walletPubkey);
      const lamports = await opts.connection.getBalance(pk, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch (err) {
      opts.logger.warn({ err, walletPubkey }, 'balance fetch failed');
      return null;
    }
  }

  return async (walletPubkey: string) => {
    const now = Date.now();

    const cached = cache.get(walletPubkey);
    if (cached && now - cached.at < ttl) return cached.balanceSol;

    const pending = inFlight.get(walletPubkey);
    if (pending) return pending;

    const promise = fetchBalance(walletPubkey).then((balanceSol) => {
      pruneIfNeeded();
      cache.set(walletPubkey, { at: Date.now(), balanceSol });
      inFlight.delete(walletPubkey);
      return balanceSol;
    });
    inFlight.set(walletPubkey, promise);
    return promise;
  };
}
