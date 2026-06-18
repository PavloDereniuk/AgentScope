/**
 * Priority fee spike rule (A.8).
 *
 * Fires when a transaction's fee exceeds N × the agent's 24h median fee
 * for the SAME program. Unlike `gas_spike` (which uses the agent-wide median),
 * this rule catches silent ComputeBudget overpay bugs where one program
 * consistently submits with a misconfigured priority fee — a signal that
 * inflates the agent-wide baseline and evades the general rule.
 *
 * Abstains when `programId` is absent from the snapshot (legacy paths) or
 * when the agent has no prior history for that program (no baseline).
 */

import { agentTransactions } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { RuleResult, TxRuleDef } from '../types';

/** Multiplier at which severity escalates from warning to critical. */
const CRITICAL_MULTIPLIER = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const priorityFeeRule: TxRuleDef = {
  name: 'priority_fee_spike',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, defaults, db, now } = ctx;

    // Abstain when programId is absent — older code paths don't populate it.
    if (!transaction.programId) return null;

    const threshold = agent.alertRules.priorityFeeMultThreshold ?? defaults.priorityFeeMult;
    if (threshold <= 0) return null;

    const since = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [row] = await db
      .select({
        median: sql<string>`(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${agentTransactions.feeLamports}))::text`,
      })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          eq(agentTransactions.programId, transaction.programId),
          gte(agentTransactions.blockTime, since),
        ),
      );

    const median = Number.parseFloat(row?.median ?? '0');
    if (Number.isNaN(median) || median <= 0) return null;

    const ratio = transaction.feeLamports / median;
    if (ratio <= threshold) return null;

    const severity = ratio >= threshold * CRITICAL_MULTIPLIER ? 'critical' : 'warning';

    return {
      ruleName: 'priority_fee_spike',
      severity,
      payload: {
        feeLamports: transaction.feeLamports,
        medianFeeLamports: median,
        ratio: Math.round(ratio * 100) / 100,
        thresholdMult: threshold,
        programId: transaction.programId,
        signature: transaction.signature,
      },
      dedupeKey: `priority_fee:${transaction.signature}`,
    };
  },
};
