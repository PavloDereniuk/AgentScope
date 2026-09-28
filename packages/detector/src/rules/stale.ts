/**
 * Stale agent rule (task 5.8).
 *
 * Fires when an agent has no transactions within the last N minutes.
 * Checks the most recent transaction's blockTime. If none exist at all,
 * the agent is considered stale (it was registered but never active).
 */

import { agentTransactions } from '@agentscope/db';
import { desc, eq } from 'drizzle-orm';
import type { CronRuleDef, RuleResult } from '../types';

// 3× threshold → critical. Matches drawdown's escalation; slippage/gas
// use 5× (swap-path rules tolerate higher overshoot before escalating).
const CRITICAL_MULTIPLIER = 3;
/** Shortest dedupe window — one day. */
const DEDUPE_FLOOR_MINUTES = 24 * 60;

export const staleRule: CronRuleDef = {
  name: 'stale_agent',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now } = ctx;
    const thresholdMinutes = agent.alertRules.staleMinutesThreshold ?? defaults.staleMinutes;
    // Non-positive thresholds would flag every agent as stale on every cycle
    // and also break the dedupe window calculation (division by zero).
    if (thresholdMinutes <= 0) return null;

    const [latest] = await db
      .select({ blockTime: agentTransactions.blockTime })
      .from(agentTransactions)
      .where(eq(agentTransactions.agentId, agent.id))
      .orderBy(desc(agentTransactions.blockTime))
      .limit(1);

    if (!latest) {
      // Never had a transaction — stale from birth.
      return {
        ruleName: 'stale_agent',
        severity: 'info',
        payload: { inactiveMinutes: null, reason: 'no transactions ever' },
        dedupeKey: `stale:${agent.id}:never`,
      };
    }

    const lastTime = new Date(latest.blockTime).getTime();
    const inactiveMs = now.getTime() - lastTime;
    const inactiveMinutes = Math.floor(inactiveMs / 60_000);

    if (inactiveMinutes <= thresholdMinutes) return null;

    const severity =
      inactiveMinutes >= thresholdMinutes * CRITICAL_MULTIPLIER ? 'critical' : 'warning';
    const windowMinutes = Math.max(thresholdMinutes, DEDUPE_FLOOR_MINUTES);

    return {
      ruleName: 'stale_agent',
      severity,
      payload: {
        inactiveMinutes,
        thresholdMinutes,
      },
      // One reminder per day at most (or per threshold, when that is longer):
      // a dead agent stays dead, and an hourly window re-fired 24×/day forever.
      // Severity is part of the key so warning → critical still escalates
      // inside the same window.
      dedupeKey: `stale:${agent.id}:${severity}:${Math.floor(now.getTime() / (windowMinutes * 60_000))}`,
    };
  },
};
