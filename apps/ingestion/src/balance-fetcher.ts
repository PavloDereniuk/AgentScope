/**
 * Wallet-balance lookup helper (post-MVP roadmap A.2 — low_balance rule;
 * E.1 — getMultipleAccounts batching).
 *
 * Exposes two entry points sharing one TTL cache:
 *   - `fetch(wallet)`  — single-wallet lookup, the `BalanceFetcher` contract
 *     the `low_balance` rule consumes. Hits the cache after a prime; on a
 *     cache miss it falls back to an individual `getBalance` (coalesced).
 *   - `primeBalances(wallets)` — batch the whole agent fleet into one
 *     (chunked) `getMultipleAccountsInfo` call per cron cycle. This is the
 *     E.1 win: 50 agents used to cost 50 `getBalance` calls per cycle
 *     (cache TTL 25s < 60s cycle, so it never hit between cycles); now the
 *     cron primes once per cycle and every per-agent read hits the warm
 *     cache — ⌈N/100⌉ RPC calls per cycle instead of N.
 *
 * Errors are swallowed (and logged) — the detector treats `null` as
 * "unknown balance" and abstains from alerting. A failed batch caches
 * `null` for the affected wallets (NOT a fall-back to N individual calls),
 * so a Helius blip never looks like a fleet-wide bankrupt-wallet event and
 * never quietly fans back out into per-agent RPC. Note the deliberate
 * asymmetry vs. a missing account: in a *successful* batch response a
 * `null` account entry means the wallet does not exist on-chain → 0 SOL
 * (a real low-balance signal), whereas a thrown RPC error → cached `null`
 * (unknown → rule abstains).
 */

import type { BalanceFetcher } from '@agentscope/detector';
import { type Connection, PublicKey } from '@solana/web3.js';

interface CacheEntry {
  at: number;
  /**
   * `null` means "balance unknown" (RPC error or malformed pubkey) — the
   * rule abstains. A real empty wallet is cached as `0`, not `null`.
   */
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
   * cycle so each cycle re-primes a fresh reading, while still serving
   * every per-agent read within the same cycle from the warm cache.
   */
  cacheTtlMs?: number;
  /** Maximum cached wallets. Bounded memory — sub-100 B per entry. */
  maxCacheSize?: number;
}

/** Single-wallet lookup plus a batch-prime for the whole fleet (E.1). */
export interface BatchBalanceFetcher {
  fetch: BalanceFetcher;
  primeBalances: (walletPubkeys: readonly string[]) => Promise<void>;
}

const DEFAULT_TTL_MS = 25_000;
const DEFAULT_MAX_CACHE = 512;
const LAMPORTS_PER_SOL = 1_000_000_000;
/** Solana RPC caps `getMultipleAccounts` at 100 keys per call. */
const MAX_ACCOUNTS_PER_CALL = 100;

export function createBalanceFetcher(opts: BalanceFetcherOptions): BatchBalanceFetcher {
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

  const fetch: BalanceFetcher = async (walletPubkey: string) => {
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

  async function primeBalances(walletPubkeys: readonly string[]): Promise<void> {
    // Dedupe (multiple agents could share a wallet) and resolve pubkeys
    // up front. A malformed pubkey is cached as null (unknown → abstain),
    // mirroring the single-wallet fetch path, and excluded from the batch.
    const seen = new Set<string>();
    const valid: Array<{ wallet: string; pk: PublicKey }> = [];
    for (const wallet of walletPubkeys) {
      if (seen.has(wallet)) continue;
      seen.add(wallet);
      try {
        valid.push({ wallet, pk: new PublicKey(wallet) });
      } catch (err) {
        opts.logger.warn({ err, walletPubkey: wallet }, 'balance prime skipped malformed pubkey');
        cache.set(wallet, { at: Date.now(), balanceSol: null });
      }
    }

    for (let i = 0; i < valid.length; i += MAX_ACCOUNTS_PER_CALL) {
      const chunk = valid.slice(i, i + MAX_ACCOUNTS_PER_CALL);
      try {
        const infos = await opts.connection.getMultipleAccountsInfo(
          chunk.map((c) => c.pk),
          'confirmed',
        );
        const at = Date.now();
        chunk.forEach((c, idx) => {
          const info = infos[idx];
          // A null account entry in a *successful* response means the
          // wallet does not exist on-chain → 0 lamports → 0 SOL (a genuine
          // empty-wallet signal the rule SHOULD see), not "unknown".
          const balanceSol = info ? info.lamports / LAMPORTS_PER_SOL : 0;
          cache.set(c.wallet, { at, balanceSol });
        });
      } catch (err) {
        // RPC error → cache null (unknown) for the whole chunk so per-agent
        // reads abstain this cycle WITHOUT fanning back out into N
        // individual getBalance calls. Next cycle re-primes.
        opts.logger.warn({ err, count: chunk.length }, 'batch balance fetch failed');
        const at = Date.now();
        for (const c of chunk) cache.set(c.wallet, { at, balanceSol: null });
      }
    }

    pruneIfNeeded();
  }

  return { fetch, primeBalances };
}
