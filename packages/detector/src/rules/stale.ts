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

export const staleRule: CronRuleDef = {
  name: 'stale_agent',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now } = ctx;
    const thresholdMinutes = agent.alertRules.staleMinutesThreshold ?? defaults.staleMinutes;

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

    return {
      ruleName: 'stale_agent',
      severity: inactiveMinutes >= thresholdMinutes * 3 ? 'critical' : 'warning',
      payload: {
        inactiveMinutes,
        thresholdMinutes,
      },
      // Dedupe window is capped at max(threshold, 60min) to prevent alert spam
      // when short thresholds (e.g. 5min) would otherwise generate one alert per window.
      dedupeKey: `stale:${agent.id}:${Math.floor(now.getTime() / (Math.max(thresholdMinutes, 60) * 60_000))}`,
    };
  },
};
