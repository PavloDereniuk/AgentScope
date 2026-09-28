/**
 * One-shot historical backfill for a wallet.
 *
 * When a new agent is registered, the ingestion worker's `onLogs`
 * subscription only captures transactions that happen **after** the
 * subscription starts. This module fetches the most recent N
 * historical transactions via `getSignaturesForAddress` →
 * `getTransaction` and feeds them through the persist pipeline so the
 * dashboard isn't empty on first load.
 *
 * Designed to be called once per wallet (at registration time or via
 * an explicit trigger). Duplicate signatures are silently skipped via
 * the unique index on `(agent_id, signature, block_time)` combined with
 * `ON CONFLICT DO NOTHING` in persistTx — so repeated backfill passes
 * (e.g. on every ingestion restart) are safe.
 */

import { type Database, agentTransactions } from '@agentscope/db';
import { Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { and, eq, inArray } from 'drizzle-orm';
import type { TxUpdate } from './grpc-client';
import type { Logger } from './logger';
import type { PersistContext } from './persist';
import { persistTx } from './persist';
import { MAX_SUPPORTED_TX_VERSION } from './tx-version';

export interface BackfillOptions {
  rpcUrl: string;
  /** Max number of historical signatures to fetch. Default 50. */
  maxSignatures?: number;
  /** Commitment level for fetches. Default 'confirmed'. */
  commitment?: 'confirmed' | 'finalized';
}

const DEFAULT_MAX_SIGNATURES = 50;
/**
 * Millisecond delay between sequential getTransaction calls.
 * Helius free tier caps at ~10–20 req/s; 100ms spacing keeps us
 * comfortably below that while still backfilling 50 tx in ~5s.
 */
const BACKFILL_FETCH_DELAY_MS = 100;

/**
 * Drop signatures the agent already has in `agent_transactions`, keeping
 * input order. Backfill runs for every wallet on every worker start, and
 * without this each restart re-fetched ~50 tx per wallet only for
 * ON CONFLICT DO NOTHING to discard them (E.16).
 */
export async function filterUnpersistedSignatures(
  db: Database,
  agentId: string,
  signatures: readonly string[],
): Promise<string[]> {
  if (signatures.length === 0) return [];
  const rows = await db
    .select({ signature: agentTransactions.signature })
    .from(agentTransactions)
    .where(
      and(
        eq(agentTransactions.agentId, agentId),
        inArray(agentTransactions.signature, [...signatures]),
      ),
    );
  const stored = new Set(rows.map((r) => r.signature));
  return signatures.filter((s) => !stored.has(s));
}

/**
 * Backfill recent transactions for a single wallet. Returns the count
 * of successfully persisted rows (duplicates return 0, not an error).
 */
export async function backfillWallet(
  walletPubkey: string,
  opts: BackfillOptions,
  ctx: PersistContext,
  logger: Logger,
): Promise<number> {
  const maxSigs = opts.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const commitment = opts.commitment ?? 'confirmed';

  const connection = new Connection(opts.rpcUrl, { commitment });

  logger.info({ walletPubkey, maxSigs }, 'backfill: fetching historical signatures');

  let signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>>;
  try {
    signatures = await connection.getSignaturesForAddress(
      new PublicKey(walletPubkey),
      { limit: maxSigs },
      commitment,
    );
  } catch (err) {
    logger.error(
      { err, walletPubkey, rpcUrl: opts.rpcUrl.replace(/api-key=[^&]+/, 'api-key=***') },
      'backfill: failed to fetch signatures',
    );
    return 0;
  }

  if (signatures.length === 0) {
    logger.info({ walletPubkey }, 'backfill: no historical signatures found');
    return 0;
  }

  const agentId = ctx.registry.lookup(walletPubkey);
  if (agentId) {
    try {
      const fresh = new Set(
        await filterUnpersistedSignatures(
          ctx.db,
          agentId,
          signatures.map((s) => s.signature),
        ),
      );
      signatures = signatures.filter((s) => fresh.has(s.signature));
    } catch (err) {
      // Filtering is an optimisation — on a DB error fall back to fetching
      // everything; persistTx's ON CONFLICT still keeps it idempotent.
      logger.warn({ err, walletPubkey }, 'backfill: persisted-signature filter failed');
    }
  }

  if (signatures.length === 0) {
    logger.info({ walletPubkey }, 'backfill: nothing new');
    return 0;
  }

  logger.info({ walletPubkey, count: signatures.length }, 'backfill: fetching transactions');

  let persisted = 0;

  // Process sequentially with a small delay between calls. Free-tier Helius
  // has fairly aggressive rate limits and this loop runs at agent-registration
  // time — a new agent doesn't need millisecond-level backfill latency, but
  // being rate-limited mid-run and silently skipping tx is worse.
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    if (!sig) continue;
    if (i > 0) {
      await new Promise((r) => setTimeout(r, BACKFILL_FETCH_DELAY_MS));
    }
    let tx: VersionedTransactionResponse | null;
    try {
      tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        commitment,
      });
    } catch (err) {
      logger.warn({ err, sig: sig.signature }, 'backfill: failed to fetch tx, skipping');
      continue;
    }

    if (!tx) {
      logger.warn({ sig: sig.signature }, 'backfill: tx not found, skipping');
      continue;
    }

    const message = tx.transaction.message;
    const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());
    const loadedWritable = (tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58());
    const loadedReadonly = (tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58());
    const allKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];

    const compiledIxs = message.compiledInstructions;
    const programIds = Array.from(
      new Set(
        compiledIxs.map((ix) => allKeys[ix.programIdIndex]).filter((k): k is string => Boolean(k)),
      ),
    );

    const update: TxUpdate = {
      signature: sig.signature,
      slot: sig.slot,
      blockTime: tx.blockTime
        ? new Date(tx.blockTime * 1000).toISOString()
        : new Date().toISOString(),
      isVote: false,
      programIds,
      rawAccountKeys: staticKeys,
      rawTx: tx,
    };

    try {
      const id = await persistTx(ctx, update);
      // persistTx returns null for ON CONFLICT DO NOTHING — count only
      // truly new rows, so `persisted` reflects fresh ingest, not retries.
      if (id !== null) persisted++;
    } catch (err) {
      logger.warn({ err, sig: sig.signature }, 'backfill: persist failed, skipping');
    }
  }

  logger.info({ walletPubkey, fetched: signatures.length, persisted }, 'backfill: completed');
  return persisted;
}
