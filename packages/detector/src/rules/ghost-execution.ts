/**
 * Ghost execution rule (Epic 17, post-MVP scope expansion 2026-05-02).
 *
 * Cron-triggered. Fires when an EXECUTE_SWAP reasoning span exists with
 * an attached `solana.tx.signature` but no matching agent_transactions
 * row has appeared within the configured window.
 *
 * Two failure modes this catches:
 *   - The agent emitted a swap span optimistically before the tx was
 *     confirmed, and the tx was dropped / never landed.
 *   - The ingestion worker missed the tx (Yellowstone backpressure,
 *     wallet not in subscription set, etc.) — a silent loss of fidelity.
 *
 * The rule scans recent reasoning_logs (only spans for the agent under
 * evaluation) older than `ghostExecutionMinutesThreshold` (default 5
 * min), and for each one queries agent_transactions for a matching
 * signature. A grace period prevents flagging in-flight txs that simply
 * have not yet been ingested.
 *
 * To bound work per cycle, the lookback is capped at 24 h. Older missing
 * txs were either alerted on previously (dedupeKey idempotent) or are
 * cold-storage events the operator no longer cares about.
 */

import { agentTransactions, reasoningLogs } from '@agentscope/db';
import type { SpanAttributes } from '@agentscope/shared';
import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { CronRuleDef, RuleResult } from '../types';

const DEFAULT_THRESHOLD_MINUTES = 5;
const LOOKBACK_HOURS = 24;
/** Span endTime grace before we consider it a candidate ghost. */
const MIN_GRACE_MINUTES = 1;

/**
 * Heuristic: a span is a "swap execution" candidate when it has both a
 * tx_signature column AND an attribute that identifies it as a swap
 * (action.name=EXECUTE_SWAP or swap.protocol set). We require both signals
 * because some agents attach tx_signature to non-swap spans (e.g. NFT
 * mint), and `swap.protocol` alone may appear on a parent span without
 * the tx_signature column populated.
 */
function isSwapExecutionSpan(spanName: string, attrs: SpanAttributes): boolean {
  if (spanName === 'EXECUTE_SWAP') return true;
  const actionName = attrs['action.name'];
  if (typeof actionName === 'string' && actionName === 'EXECUTE_SWAP') return true;
  if (typeof attrs['swap.protocol'] === 'string') return true;
  return false;
}

export const ghostExecutionRule: CronRuleDef = {
  name: 'ghost_execution',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, db, now } = ctx;
    const thresholdMinutes =
      agent.alertRules.ghostExecutionMinutesThreshold ?? DEFAULT_THRESHOLD_MINUTES;
    if (thresholdMinutes <= 0) return null;
    if (thresholdMinutes < MIN_GRACE_MINUTES) return null;

    const upperBound = new Date(now.getTime() - thresholdMinutes * 60_000);
    const lowerBound = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000);

    // Why we don't pre-filter via SQL JOIN: agent_transactions is partitioned
    // by block_time and the join across the partition root is slower than
    // small per-span lookups when candidate counts are tens of rows. Revisit
    // if a heavy agent ever produces hundreds of ghost candidates per cycle.
    const candidates = await db
      .select({
        spanId: reasoningLogs.spanId,
        traceId: reasoningLogs.traceId,
        spanName: reasoningLogs.spanName,
        endTime: reasoningLogs.endTime,
        attributes: reasoningLogs.attributes,
        txSignature: reasoningLogs.txSignature,
      })
      .from(reasoningLogs)
      .where(
        and(
          eq(reasoningLogs.agentId, agent.id),
          isNotNull(reasoningLogs.txSignature),
          gte(reasoningLogs.endTime, lowerBound.toISOString()),
          lte(reasoningLogs.endTime, upperBound.toISOString()),
        ),
      );

    if (candidates.length === 0) return null;

    const ghosts: Array<{
      spanId: string;
      traceId: string;
      txSignature: string;
      ageMinutes: number;
    }> = [];

    for (const span of candidates) {
      if (!span.txSignature) continue;
      const attrs = span.attributes as SpanAttributes;
      if (!isSwapExecutionSpan(span.spanName, attrs)) continue;

      const [tx] = await db
        .select({ signature: agentTransactions.signature })
        .from(agentTransactions)
        .where(
          and(
            eq(agentTransactions.agentId, agent.id),
            eq(agentTransactions.signature, span.txSignature),
          ),
        )
        .limit(1);

      if (tx) continue;

      const ageMs = now.getTime() - new Date(span.endTime).getTime();
      ghosts.push({
        spanId: span.spanId,
        traceId: span.traceId,
        txSignature: span.txSignature,
        ageMinutes: Math.floor(ageMs / 60_000),
      });
    }

    if (ghosts.length === 0) return null;

    // Use the oldest ghost as the dedupe anchor — alerting once per stuck
    // tx is what the operator cares about. Newer ghosts ride along in the
    // payload list so the same Telegram message surfaces all of them.
    const oldest = ghosts.reduce((a, b) => (a.ageMinutes >= b.ageMinutes ? a : b));

    return {
      ruleName: 'ghost_execution',
      severity: ghosts.length > 1 ? 'critical' : 'warning',
      payload: {
        thresholdMinutes,
        ghostCount: ghosts.length,
        oldestSignature: oldest.txSignature,
        oldestAgeMinutes: oldest.ageMinutes,
        ghosts: ghosts.slice(0, 10),
      },
      // Dedupe per signature: a single stuck tx must not retrigger every
      // cron tick, but distinct stuck txs each get their own alert.
      dedupeKey: `ghost_execution:${oldest.txSignature}`,
    };
  },
};
