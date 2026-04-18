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
 * an explicit trigger). Duplicate signatures are silently skipped by
 * the DB's unique constraint on `(agent_id, signature)`.
 */

import { Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import type { TxUpdate } from './grpc-client';
import type { Logger } from './logger';
import type { PersistContext } from './persist';
import { persistTx } from './persist';

export interface BackfillOptions {
  rpcUrl: string;
  /** Max number of historical signatures to fetch. Default 50. */
  maxSignatures?: number;
  /** Commitment level for fetches. Default 'confirmed'. */
  commitment?: 'confirmed' | 'finalized';
}

const DEFAULT_MAX_SIGNATURES = 50;

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

  logger.info({ walletPubkey, count: signatures.length }, 'backfill: fetching transactions');

  let persisted = 0;

  // Process sequentially to avoid hammering the RPC. Free-tier Helius
  // has fairly aggressive rate limits.
  for (const sig of signatures) {
    let tx: VersionedTransactionResponse | null;
    try {
      tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
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
      if (id !== null) persisted++;
    } catch (err) {
      // Unique constraint violations are expected for duplicate sigs — skip silently.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('duplicate') || msg.includes('unique')) {
        continue;
      }
      logger.warn({ err, sig: sig.signature }, 'backfill: persist failed, skipping');
    }
  }

  logger.info({ walletPubkey, fetched: signatures.length, persisted }, 'backfill: completed');
  return persisted;
}
