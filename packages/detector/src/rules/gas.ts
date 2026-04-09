/**
 * Gas spike rule (task 5.5).
 *
 * Fires when a transaction's fee exceeds N × the agent's rolling 24h
 * median fee. If the agent has no prior transactions (no median), the
 * rule silently skips — there's no baseline to compare against.
 */

import { agentTransactions } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { RuleResult, TxRuleDef } from '../types';

/** Multiplier at which severity escalates from warning to critical. */
const CRITICAL_MULTIPLIER = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const gasRule: TxRuleDef = {
  name: 'gas_spike',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, defaults, db, now } = ctx;

    const threshold = agent.alertRules.gasMultThreshold ?? defaults.gasMult;
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [row] = await db
      .select({
        median: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${agentTransactions.feeLamports})`,
      })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, agent.id), gte(agentTransactions.blockTime, since)));

    const median = row?.median;
    if (median == null || median <= 0) return null;

    const ratio = transaction.feeLamports / median;
    if (ratio <= threshold) return null;

    const severity = ratio >= threshold * CRITICAL_MULTIPLIER ? 'critical' : 'warning';

    return {
      ruleName: 'gas_spike',
      severity,
      payload: {
        feeLamports: transaction.feeLamports,
        medianFeeLamports: median,
        ratio: Math.round(ratio * 100) / 100,
        thresholdMult: threshold,
        signature: transaction.signature,
      },
      dedupeKey: `gas:${transaction.signature}`,
    };
  },
};
