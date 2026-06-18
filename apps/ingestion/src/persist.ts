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
 * Program IDs that are pure infrastructure wrappers — they show up
 * in nearly every tx but never represent the user-intent. We always
 * deprioritize them when picking a primary instruction so the
 * dashboard doesn't surface "Compute Budget" for a SOL transfer.
 *
 * Note: System Program (1111...) is intentionally NOT here — a
 * SystemProgram::Transfer is a meaningful primary action.
 */
const INFRA_PROGRAM_IDS = new Set([
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'Memo1UhkJBfCvE3urwUn9vNyTxWVF2qB2nRF3NsKNFt6',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'AddressLookupTab1e1111111111111111111111111',
]);

/**
 * Persisted rawLogs caps (E.2 — storage diet).
 *
 * Jupiter swaps routinely emit 500-2000 log lines; storing them verbatim
 * bloats the jsonb column (it dominates the ~2.5 KB/tx footprint) without
 * adding information the dashboard needs — full logs stay available via RPC.
 *
 * We keep a *slim* slice on success (the happy path the dashboard rarely
 * inspects line-by-line) and a *fuller* slice on failure (where the log tail
 * is the primary diagnostic surface). On a typical success-heavy agent this
 * cuts stored log volume ~10× on the big swaps, ~2.5× across the table.
 */
export const RAW_LOGS_LIMIT_SUCCESS = 20;
export const RAW_LOGS_LIMIT_FAILURE = 200;

/**
 * Cap a rawLogs array for persistence. Returns a fresh array. When the log
 * exceeds the success/failure limit, keep the head and tail slices joined by
 * a "…truncated N lines…" marker so first-and-last diagnostics survive.
 */
export function capRawLogs(rawLogs: readonly string[], success: boolean): string[] {
  const limit = success ? RAW_LOGS_LIMIT_SUCCESS : RAW_LOGS_LIMIT_FAILURE;
  if (rawLogs.length <= limit) return [...rawLogs];
  const half = Math.floor(limit / 2);
  return [
    ...rawLogs.slice(0, half),
    `…truncated ${rawLogs.length - limit} lines…`,
    ...rawLogs.slice(-half),
  ];
}

/** A single entry in the compact `_all` instruction outline (E.5). */
export interface InstructionOutlineEntry {
  index: number;
  programId: string;
  name: string;
}

/**
 * Build the compact `_all` instruction outline (E.5 — storage diet).
 *
 * `parsed_args._all` keeps program id + name + index for every instruction in
 * the tx, but deliberately NOT each instruction's args. The primary
 * instruction's args already sit at the top level of `parsed_args`; carrying
 * full per-hop args inside `_all` duplicated those and bloated the jsonb on
 * multi-hop Jupiter routes — all for data nothing reads (the dashboard
 * tx-drawer doesn't surface `parsedArgs`, and detector rules only consume the
 * top-level primary args). The outline still answers "which instructions ran".
 */
export function compactInstructionOutline(
  instructions: readonly { index: number; programId: string; name: string }[],
): InstructionOutlineEntry[] {
  return instructions.map((ix) => ({ index: ix.index, programId: ix.programId, name: ix.name }));
}

/**
 * Pick the most "interesting" parsed instruction in the tx — the
 * primary user-visible operation. Priority order:
 *   1. Decoded protocol op on a non-infra program (jupiter.swap,
 *      kamino.deposit, system.transfer)
 *   2. Recognized non-infra (includes kamino.refresh_*, kamino.init_*,
 *      and bare friendly names like "Bubblegum (cNFT)")
 *   3. Any non-infra instruction (even <prefix>.unknown — at least we
 *      know which protocol triggered it)
 *   4. First instruction overall (pure-infra tx — shows "Compute Budget")
 */
function pickPrimaryInstruction(parsed: ParsedTx) {
  const ixs = parsed.instructions;
  if (ixs.length === 0) return null;

  const isInfra = (ix: { programId: string }) => INFRA_PROGRAM_IDS.has(ix.programId);
  const isUnknown = (ix: { name: string }) => ix.name === 'unknown' || ix.name.endsWith('.unknown');
  const isUtility = (ix: { name: string }) =>
    ix.name.startsWith('kamino.refresh_') || ix.name.startsWith('kamino.init_');

  const meaningful = ixs.filter((ix) => !isInfra(ix) && !isUnknown(ix) && !isUtility(ix));
  if (meaningful[0]) return meaningful[0];

  const recognizedNonInfra = ixs.filter((ix) => !isInfra(ix) && !isUnknown(ix));
  if (recognizedNonInfra[0]) return recognizedNonInfra[0];

  const nonInfra = ixs.filter((ix) => !isInfra(ix));
  if (nonInfra[0]) return nonInfra[0];

  return ixs[0] ?? null;
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
  // Compact `_all` outline (E.5) — program/name/index per instruction, no
  // per-hop args. See compactInstructionOutline above.
  const instructionOutline = compactInstructionOutline(parsed?.instructions ?? []);

  // Build the parsedArgs payload once and reuse it for both the DB insert
  // and the detector runner — avoids allocating the `_all` list twice per tx.
  const parsedArgsPayload = primary ? { ...primary.args, _all: instructionOutline } : null;

  // Cap persisted rawLogs (E.2) — slim on success, fuller on failure.
  // See capRawLogs / RAW_LOGS_LIMIT_* above. When the tx wasn't parsed we
  // have no logs to store.
  const limitedRawLogs = parsed ? capRawLogs(parsed.rawLogs, parsed.success) : [];

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
        ixCount: instructionOutline.length,
      },
      'persisted tx',
    );

    // Publish tx.new event for SSE (6.15). 13.13 added the per-user
    // fan-out channel, so we now also carry userId so the bus can
    // deliver to /api/stream subscribers. `userIdFor` is populated at
    // registry refresh; if an agent was created in the current tick and
    // hasn't been refreshed yet, we skip the publish rather than emit a
    // half-routed event.
    const userId = ctx.registry.userIdFor(agentId);
    if (userId) {
      ctx.publishEvent?.({
        type: 'tx.new',
        agentId,
        userId,
        signature: tx.signature,
        at: new Date().toISOString(),
      });
    }

    // Run tx-triggered detector rules (5.9).
    if (ctx.detector) {
      try {
        const alertCount = await runTxDetector(ctx.detector, agentId, {
          signature: tx.signature,
          slot: tx.slot,
          instructionName: primary?.name ?? null,
          parsedArgs: parsedArgsPayload,
          solDelta: parsed?.solDelta ?? '0',
          tokenDeltas: parsed ? [...parsed.tokenDeltas] : [],
          feeLamports: parsed?.feeLamports ?? 0,
          success: parsed?.success ?? true,
          blockTime: tx.blockTime,
          programId: primary?.programId ?? tx.programIds[0],
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
