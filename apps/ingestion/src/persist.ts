/**
 * Persistence layer for incoming transactions.
 *
 * 1.11: write the raw row keyed by registered agent wallet
 * 2.11: enrich with parsed instruction name + args + accurate
 *       sol/token deltas computed by @agentscope/parser
 * 5.9 will invoke the detector after each persist.
 */

import { type Database, agentTransactions, agents } from '@agentscope/db';
import { type ParseInput, type ParsedTx, parseTransaction } from '@agentscope/parser';
import type { ISOTimestamp, SolanaPubkey, SolanaSignature } from '@agentscope/shared';
import { eq, sql } from 'drizzle-orm';
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
/** Program IDs of system/infra programs that never represent the primary user intent. */
const SYSTEM_PROGRAM_PREFIXES = new Set([
  'comp', // ComputeBudget
  '1111', // System Program (1111...)
  'toke', // Token Program (Toke...)
  'atas', // ATA Program (ATAs...)
  'memo', // Memo Program
]);

function pickPrimaryInstruction(parsed: ParsedTx) {
  const recognized = parsed.instructions.filter((ix) => !ix.name.endsWith('.unknown'));
  // Skip refresh / utility instructions when picking the primary.
  const meaningful = recognized.filter(
    (ix) => !ix.name.startsWith('kamino.refresh_') && !ix.name.startsWith('kamino.init_'),
  );
  if (meaningful[0]) return meaningful[0];
  if (recognized[0]) return recognized[0];

  // All unknown — prefer non-system programs over ComputeBudget/System/Token.
  const nonSystem = parsed.instructions.filter(
    (ix) => !SYSTEM_PROGRAM_PREFIXES.has(ix.name.split('.')[0] ?? ''),
  );
  return nonSystem[0] ?? parsed.instructions[0] ?? null;
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
  // Resolve wallet and agentId in a single lookup to avoid a race between
  // two separate registry.lookup() calls if the cache refreshes in between.
  let agentId: string | undefined;
  const matchedWallet = tx.rawAccountKeys.find((k) => {
    const id = ctx.registry.lookup(k);
    if (id !== undefined) {
      agentId = id;
      return true;
    }
    return false;
  });
  if (!matchedWallet || !agentId) return null;

  // Bump last_seen_at and flip status to 'live' whenever we observe a tx
  // for a registered agent. GREATEST guards backfill (which feeds historical
  // tx on startup) from overwriting a fresher value set by the live WS
  // stream. Runs before the insert so duplicate-tx inserts (on restart /
  // re-backfill) still refresh the agent's freshness state.
  try {
    await ctx.db
      .update(agents)
      .set({
        lastSeenAt: sql`GREATEST(COALESCE(${agents.lastSeenAt}, 'epoch'::timestamptz), ${tx.blockTime}::timestamptz)`,
        status: 'live',
      })
      .where(eq(agents.id, agentId));
  } catch (err) {
    ctx.logger.warn({ err, agentId }, 'failed to bump last_seen_at');
  }

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

  // Build the parsedArgs payload once and reuse it for both the DB insert
  // and the detector runner — avoids allocating the `_all` list twice per tx.
  const parsedArgsPayload = primary ? { ...primary.args, _all: allInstructions } : null;

  // Cap persisted rawLogs. Jupiter swaps routinely emit 500-2000 log lines;
  // storing them verbatim bloats the jsonb column and makes list queries
  // slow without adding information for the dashboard (full logs stay
  // available via RPC). Keep only the first and last slice for diagnostics
  // on failed txs.
  const RAW_LOGS_LIMIT = 200;
  const limitedRawLogs = parsed
    ? parsed.rawLogs.length <= RAW_LOGS_LIMIT
      ? [...parsed.rawLogs]
      : [
          ...parsed.rawLogs.slice(0, RAW_LOGS_LIMIT / 2),
          `…truncated ${parsed.rawLogs.length - RAW_LOGS_LIMIT} lines…`,
          ...parsed.rawLogs.slice(-RAW_LOGS_LIMIT / 2),
        ]
    : [];

  try {
    // Idempotent insert: the (agent_id, signature, block_time) unique index
    // (migration 0003) swallows duplicates silently. Without this, every
    // ingestion restart would re-insert the backfilled history, producing
    // N× copies of each tx. When the row already exists, `returning` comes
    // back empty and we bail out before running the detector — re-running
    // rules on historical rows would spam the alerts feed.
    const inserted = await ctx.db
      .insert(agentTransactions)
      .values({
        agentId,
        signature: tx.signature,
        slot: tx.slot,
        blockTime: tx.blockTime,
        programId: primary?.programId ?? tx.programIds[0] ?? '',
        instructionName: primary?.name ?? null,
        parsedArgs: parsedArgsPayload,
        solDelta: parsed?.solDelta ?? '0',
        tokenDeltas: parsed ? [...parsed.tokenDeltas] : [],
        feeLamports: parsed?.feeLamports ?? 0,
        success: parsed?.success ?? true,
        rawLogs: limitedRawLogs,
      })
      .onConflictDoNothing({
        target: [
          agentTransactions.agentId,
          agentTransactions.signature,
          agentTransactions.blockTime,
        ],
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
          parsedArgs: parsedArgsPayload,
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
