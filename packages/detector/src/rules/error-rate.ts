/**
 * Error rate rule (task 5.6).
 *
 * Fires when the ratio of failed transactions in the past 1 hour
 * exceeds the configured threshold. Skips if there are no transactions
 * in the window (nothing to evaluate).
 */

import { agentTransactions } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { CronRuleDef, RuleResult } from '../types';

const WINDOW_MS = 60 * 60 * 1000;
// Error-rate escalates to critical at 2× the threshold — lower than other
// rules (gas/slippage: 5×, drawdown/stale: 3×) because error-rate is a
// ratio of failed txs, where 2× overshoot already signals a systemic
// failure (e.g. RPC outage, program deploy regression).
const CRITICAL_MULTIPLIER = 2;

export const errorRateRule: CronRuleDef = {
  name: 'error_rate',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now } = ctx;
    const threshold = agent.alertRules.errorRatePctThreshold ?? defaults.errorRatePct;
    // A non-positive threshold would flag every tx with a single failure as
    // critical (alert storm on misconfig); skip entirely.
    if (threshold <= 0) return null;
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) FILTER (WHERE NOT ${agentTransactions.success})::int`,
      })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, agent.id), gte(agentTransactions.blockTime, since)));

    const total = row?.total ?? 0;
    const failed = row?.failed ?? 0;
    if (total === 0) return null;

    const ratePct = (failed / total) * 100;
    if (ratePct <= threshold) return null;

    return {
      ruleName: 'error_rate',
      severity: ratePct >= threshold * CRITICAL_MULTIPLIER ? 'critical' : 'warning',
      payload: {
        ratePct: Math.round(ratePct * 100) / 100,
        thresholdPct: threshold,
        failed,
        total,
        windowMinutes: 60,
      },
      dedupeKey: `error_rate:${agent.id}:${Math.floor(now.getTime() / WINDOW_MS)}`,
    };
  },
};
