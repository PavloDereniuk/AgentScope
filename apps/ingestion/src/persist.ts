/**
 * Persistence layer for incoming transactions.
 *
 * 1.11: write the raw row (no parsing yet — instructionName/parsedArgs null).
 * 2.11 will append the parsed instruction details and token deltas.
 * 5.9 will invoke the detector after each persist.
 */

import { type Database, agentTransactions } from '@agentscope/db';
import type { TxUpdate } from './grpc-client';
import type { Logger } from './logger';
import type { WalletRegistry } from './registry';

export interface PersistContext {
  db: Database;
  registry: WalletRegistry;
  logger: Logger;
}

/**
 * Match a tx to a registered agent and persist it.
 *
 * Matching strategy: walk the tx's account keys (signer keys come first
 * in the message), pick the FIRST account that's in the registry. This
 * attributes the tx to the most likely "owner" agent — the signer or,
 * failing that, the first referenced wallet.
 *
 * Returns the inserted row's id, or null if no registered wallet matched.
 */
export async function persistTx(ctx: PersistContext, tx: TxUpdate): Promise<number | null> {
  const matchedWallet = tx.rawAccountKeys.find((k) => ctx.registry.lookup(k) !== undefined);
  if (!matchedWallet) return null;

  const agentId = ctx.registry.lookup(matchedWallet);
  if (!agentId) return null;

  const blockTime = new Date().toISOString();
  // NOTE: Yellowstone tx updates don't carry block_time directly — only
  // slot. We use the receive time as a stand-in until task 2.11 augments
  // this with a proper block_time fetch via getBlockTime() RPC.

  try {
    const inserted = await ctx.db
      .insert(agentTransactions)
      .values({
        agentId,
        signature: tx.signature,
        slot: tx.slot,
        blockTime,
        programId: tx.programIds[0] ?? '',
        instructionName: null,
        parsedArgs: null,
        solDelta: '0',
        tokenDeltas: [],
        feeLamports: 0,
        success: true,
        rawLogs: [],
      })
      .returning({ id: agentTransactions.id });

    const row = inserted[0];
    if (!row) return null;

    ctx.logger.info(
      {
        agentId,
        signature: tx.signature,
        slot: tx.slot,
        programs: tx.programIds.length,
      },
      'persisted tx',
    );
    return row.id;
  } catch (err) {
    ctx.logger.error({ err, signature: tx.signature }, 'failed to persist tx');
    return null;
  }
}
