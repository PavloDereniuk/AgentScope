/**
 * Slot-neighbour lookup helper (A.1 Phase 2 — sandwich detector
 * confirmation layer).
 *
 * Given a slot, returns the set of confirmed transactions that landed
 * inside that block, projected to the minimal shape the `slippage_sandwich`
 * rule consumes: signature, fee, programIds, success.
 *
 * Two performance concessions for the free Helius tier:
 *   1. Per-slot TTL cache — multiple Jupiter swaps in the same slot
 *      share one `getBlock` call.
 *   2. Concurrent-call coalescing — overlapping requests for the same
 *      slot return the same in-flight promise rather than racing the
 *      RPC. This matters when an agent emits 3+ swaps in 400ms and the
 *      detector fires before the first `getBlock` completes.
 *
 * Errors are swallowed (and logged) — the detector treats absence of
 * evidence as "no confirmation", never as a fatal failure. Returning an
 * empty array preserves that contract and keeps the alert path running
 * during RPC outages.
 */

import type { NeighbourFetcher, SlotNeighbourTx } from '@agentscope/detector';
import type { Connection, Message, MessageV0 } from '@solana/web3.js';

interface CacheEntry {
  at: number;
  data: readonly SlotNeighbourTx[];
}

/**
 * Structural subset of pino's Logger surface — the only method this
 * module touches is `warn`. Narrowing here keeps the test fixture simple
 * (no need to stub `fatal`/`silent`/`level`/etc.) while staying compatible
 * with the real pino instance at runtime.
 */
interface WarnLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface SlotNeighbourFetcherOptions {
  connection: Connection;
  logger: WarnLogger;
  /** TTL for cached blocks. Defaults to 30s — slots are immutable once finalized. */
  cacheTtlMs?: number;
  /** Maximum cached slots. Keeps memory bounded; ~1 KB per entry. */
  maxCacheSize?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_CACHE = 256;

/**
 * Resolve program ids referenced by a transaction. Both legacy and v0
 * messages compile their account indices the same way; the only
 * difference is where the keys live (static for v0 + ALT-loaded under
 * `meta.loadedAddresses`, vs `accountKeys` for legacy).
 */
function extractProgramIds(
  message: Message | MessageV0,
  loaded:
    | {
        writable?: ReadonlyArray<{ toBase58: () => string }>;
        readonly?: ReadonlyArray<{ toBase58: () => string }>;
      }
    | null
    | undefined,
): readonly string[] {
  // Build the full account-keys array in the order Solana resolves it:
  // static keys first, then ALT-loaded writable, then ALT-loaded readonly.
  const keys: string[] = [];
  // Both Message and MessageV0 expose `staticAccountKeys` in current @solana/web3.js;
  // older Message also exposes `accountKeys` — prefer staticAccountKeys when present.
  const candidate = (message as MessageV0).staticAccountKeys ?? (message as Message).accountKeys;
  for (const k of candidate) keys.push(k.toBase58());
  if (loaded) {
    for (const k of loaded.writable ?? []) keys.push(k.toBase58());
    for (const k of loaded.readonly ?? []) keys.push(k.toBase58());
  }

  // Walk compiled instructions and resolve each `programIdIndex`.
  // MessageV0 uses `compiledInstructions` (with `accountKeyIndexes`);
  // legacy Message uses `instructions` (with `accounts`). Their typed
  // shapes differ but both carry the same `programIdIndex` field, which
  // is the only one we need — so we erase to a minimal structural type.
  const v0Ixs = (message as MessageV0).compiledInstructions as
    | ReadonlyArray<{ programIdIndex: number }>
    | undefined;
  const legacyIxs = (message as Message).instructions as
    | ReadonlyArray<{ programIdIndex: number }>
    | undefined;
  const ixs = v0Ixs ?? legacyIxs ?? [];
  const programIds = new Set<string>();
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (pid) programIds.add(pid);
  }
  return [...programIds];
}

export function createSlotNeighbourFetcher(opts: SlotNeighbourFetcherOptions): NeighbourFetcher {
  const ttl = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  const maxSize = opts.maxCacheSize ?? DEFAULT_MAX_CACHE;
  const cache = new Map<number, CacheEntry>();
  const inFlight = new Map<number, Promise<readonly SlotNeighbourTx[]>>();

  function pruneIfNeeded(): void {
    if (cache.size < maxSize) return;
    // FIFO eviction — Map preserves insertion order in JS, so the
    // first key is the oldest. Drop a fixed batch to amortise the work.
    const dropCount = Math.max(1, Math.floor(maxSize / 8));
    const it = cache.keys();
    for (let i = 0; i < dropCount; i++) {
      const next = it.next();
      if (next.done) break;
      cache.delete(next.value);
    }
  }

  async function fetchBlock(slot: number): Promise<readonly SlotNeighbourTx[]> {
    try {
      const block = await opts.connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        transactionDetails: 'full',
        rewards: false,
      });
      if (!block) return [];

      const result: SlotNeighbourTx[] = [];
      for (const entry of block.transactions) {
        const tx = entry.transaction;
        const meta = entry.meta;
        const sig = tx.signatures[0];
        if (!sig) continue;
        const feeLamports = meta?.fee ?? 0;
        const success = meta?.err === null || meta?.err === undefined;
        const programIds = extractProgramIds(tx.message, meta?.loadedAddresses);
        result.push({ signature: sig, feeLamports, programIds, success });
      }
      return result;
    } catch (err) {
      opts.logger.warn({ err, slot }, 'slot-neighbour fetch failed');
      return [];
    }
  }

  return async (slot: number) => {
    const now = Date.now();

    const cached = cache.get(slot);
    if (cached && now - cached.at < ttl) return cached.data;

    const pending = inFlight.get(slot);
    if (pending) return pending;

    const promise = fetchBlock(slot).then((data) => {
      pruneIfNeeded();
      cache.set(slot, { at: Date.now(), data });
      inFlight.delete(slot);
      return data;
    });
    inFlight.set(slot, promise);
    return promise;
  };
}
