/**
 * Persistence layer for incoming transactions.
 *
 * 1.11: write the raw row keyed by registered agent wallet
 * 2.11: enrich with parsed instruction name + args + accurate
 *       sol/token deltas computed by @agentscope/parser
 * 5.9 will invoke the detector after each persist.
 */

import { type Database, agentTransactions } from '@agentscope/db';
import { type ParseInput, type ParsedTx, parseTransaction } from '@agentscope/parser';
import type { ISOTimestamp, SolanaPubkey, SolanaSignature } from '@agentscope/shared';
import { type DetectorDeps, runTxDetector } from './detector-runner';
import type { TxUpdate } from './grpc-client';
import type { Logger } from './logger';
import type { WalletRegistry } from './registry';

export interface PersistContext {
  db: Database;
  registry: WalletRegistry;
  logger: Logger;
  /** Detector deps. When absent, detection is skipped (e.g. in tests). */
  detector?: DetectorDeps;
  /** Optional callback to publish SSE events to the API (6.15). */
  publishEvent?: (event: { type: string; agentId: string; [key: string]: unknown }) => void;
}

/**
 * Pick the most "interesting" parsed instruction in the tx — the
 * primary user-visible operation. We prefer recognized lending /
 * swap ops over utility wrappers (refresh_*, init_*, ATA setup) so
 * the timeline shows "kamino.deposit" instead of "kamino.refresh_reserve".
 */
function pickPrimaryInstruction(parsed: ParsedTx) {
  const recognized = parsed.instructions.filter((ix) => !ix.name.endsWith('.unknown'));
  // Skip refresh / utility instructions when picking the primary.
  const meaningful = recognized.filter(
    (ix) => !ix.name.startsWith('kamino.refresh_') && !ix.name.startsWith('kamino.init_'),
  );
  return meaningful[0] ?? recognized[0] ?? parsed.instructions[0] ?? null;
}

/**
 * Match a tx to a registered agent and persist it. If the tx update
 * carries a rawTx (ws-stream populates it via getTransaction), we
 * run the parser dispatcher to fill in the instruction name, args,
 * and accurate balance deltas. The grpc-client path leaves rawTx
 * undefined and we fall back to a raw insert.
 *
 * Returns the inserted row's id, or null if no registered wallet matched.
 */
export async function persistTx(ctx: PersistContext, tx: TxUpdate): Promise<number | null> {
  const matchedWallet = tx.rawAccountKeys.find((k) => ctx.registry.lookup(k) !== undefined);
  if (!matchedWallet) return null;

  const agentId = ctx.registry.lookup(matchedWallet);
  if (!agentId) return null;

  // Parse if we have the raw tx; otherwise insert minimal row.
  let parsed: ParsedTx | null = null;
  if (tx.rawTx) {
    try {
      const input: ParseInput = {
        signature: tx.signature as SolanaSignature,
        slot: tx.slot,
        blockTime: tx.blockTime as ISOTimestamp,
        ownerPubkey: matchedWallet as SolanaPubkey,
        transaction: tx.rawTx,
      };
      parsed = parseTransaction(input);
    } catch (err) {
      ctx.logger.warn({ err, signature: tx.signature }, 'parser threw, falling back to raw insert');
    }
  }

  const primary = parsed ? pickPrimaryInstruction(parsed) : null;
  const allInstructions =
    parsed?.instructions.map((ix) => ({
      index: ix.index,
      programId: ix.programId,
      name: ix.name,
      args: ix.args,
    })) ?? [];

  try {
    const inserted = await ctx.db
      .insert(agentTransactions)
      .values({
        agentId,
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        programId: primary?.programId ?? tx.programIds[0] ?? '',
        instructionName: primary?.name ?? null,
        parsedArgs: primary ? { ...primary.args, _all: allInstructions } : null,
        solDelta: parsed?.solDelta ?? '0',
        tokenDeltas: parsed ? [...parsed.tokenDeltas] : [],
        feeLamports: parsed?.feeLamports ?? 0,
        success: parsed?.success ?? true,
        rawLogs: parsed ? [...parsed.rawLogs] : [],
      })
      .returning({ id: agentTransactions.id });

    const row = inserted[0];
    if (!row) return null;

    ctx.logger.info(
      {
        agentId,
        signature: tx.signature,
        slot: tx.slot,
        instruction: primary?.name ?? '(none)',
        ixCount: allInstructions.length,
      },
      'persisted tx',
    );

    // Publish tx.new event for SSE (6.15).
    ctx.publishEvent?.({
      type: 'tx.new',
      agentId,
      signature: tx.signature,
      at: new Date().toISOString(),
    });

    // Run tx-triggered detector rules (5.9).
    if (ctx.detector) {
      try {
        const alertCount = await runTxDetector(ctx.detector, agentId, {
          signature: tx.signature,
          instructionName: primary?.name ?? null,
          parsedArgs: primary ? { ...primary.args, _all: allInstructions } : null,
          solDelta: parsed?.solDelta ?? '0',
          feeLamports: parsed?.feeLamports ?? 0,
          success: parsed?.success ?? true,
          blockTime: tx.blockTime,
        });
        if (alertCount > 0) {
          ctx.logger.info({ agentId, signature: tx.signature, alertCount }, 'detector fired');
        }
      } catch (err) {
        ctx.logger.error({ err, signature: tx.signature }, 'detector runner failed');
      }
    }

    return row.id;
  } catch (err) {
    ctx.logger.error({ err, signature: tx.signature }, 'failed to persist tx');
    return null;
  }
}
