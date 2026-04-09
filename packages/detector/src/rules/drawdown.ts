/**
 * Drawdown rule (task 5.7).
 *
 * Fires when the cumulative SOL delta over the past 1 hour is more
 * negative than -N% of the agent's starting balance in that window.
 *
 * For MVP: uses absolute SOL loss (sum of solDelta) and a fixed
 * reference balance of 1 SOL. Post-MVP should use actual agent balance
 * or the balance at the start of the window.
 */

import { agentTransactions } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { CronRuleDef, RuleResult } from '../types';

const WINDOW_MS = 60 * 60 * 1000;

/**
 * MVP reference balance in SOL. Without a balance oracle we assume 1 SOL
 * so the drawdown % is effectively "SOL lost in the window."
 * Post-MVP: read actual balance from chain or from a cached snapshot.
 */
const REFERENCE_BALANCE_SOL = 1;

export const drawdownRule: CronRuleDef = {
  name: 'drawdown',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now } = ctx;
    const threshold = agent.alertRules.drawdownPctThreshold ?? defaults.drawdownPct;
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [row] = await db
      .select({
        totalDelta: sql<string>`COALESCE(SUM(${agentTransactions.solDelta}::numeric), 0)::text`,
        txCount: sql<number>`count(*)::int`,
      })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, agent.id), gte(agentTransactions.blockTime, since)));

    const txCount = row?.txCount ?? 0;
    if (txCount === 0) return null;

    const totalDelta = Number.parseFloat(row?.totalDelta ?? '0');
    if (totalDelta >= 0) return null;

    const drawdownPct = (Math.abs(totalDelta) / REFERENCE_BALANCE_SOL) * 100;
    if (drawdownPct <= threshold) return null;

    return {
      ruleName: 'drawdown',
      severity: drawdownPct >= threshold * 3 ? 'critical' : 'warning',
      payload: {
        drawdownPct: Math.round(drawdownPct * 100) / 100,
        thresholdPct: threshold,
        totalDeltaSol: totalDelta,
        windowMinutes: 60,
      },
      dedupeKey: `drawdown:${agent.id}:${Math.floor(now.getTime() / WINDOW_MS)}`,
    };
  },
};
