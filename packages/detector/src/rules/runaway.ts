/**
 * Runaway-loop rule (post-MVP roadmap A.3, v0.4.2).
 *
 * Fires when the agent's mean transaction rate over a 5-minute sliding
 * window exceeds the configured cap (default 30 tx/min). Cron-triggered —
 * runs on the same 60s cycle as drawdown / error_rate / low_balance.
 *
 * Catches the failure mode where an agent is stuck in a retry loop (RPC
 * timeouts cycling forever) or where the LLM keeps re-deciding the same
 * trade. Both burn priority fees regardless of whether the swap lands —
 * so unlike `error_rate`, this rule counts BOTH success and failed tx.
 * That distinction is the whole point: a 100% failed tx storm trips
 * error_rate; a 50/50 success/fail storm at 80 tx/min trips only this
 * rule, but is just as gas-draining and just as much "the bot lost
 * control of itself".
 *
 * Window choice (5 min vs 1h): retry loops need to be caught fast. A 1h
 * window would smear a 10-minute burst across an hour and miss it. 5 min
 * is short enough to surface the burst but long enough that a healthy
 * agent doing 20 quick swaps in a row doesn't trip.
 *
 * Dedupe (5-min bucket) is intentionally tighter than drawdown's 1h key.
 * If the loop persists past one window, the next bucket fires again so
 * the user gets re-paged — they want to know the loop is still running,
 * not be silenced after the first alert.
 */

import { agentTransactions } from '@agentscope/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { CronRuleDef, RuleResult } from '../types';

const WINDOW_MINUTES = 5;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
// Critical escalates at 2× threshold, same slope as error_rate — both rules
// signal a systemic loss-of-control where overshoot is a strict-worse
// classifier than the warning level (vs gas/slippage where 5× makes sense
// because a single 5× spike is qualitatively different from a 1.1× one).
const CRITICAL_MULTIPLIER = 2;

export const runawayRule: CronRuleDef = {
  name: 'tx_rate_anomaly',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now } = ctx;
    const threshold = agent.alertRules.txRateMaxPerMinThreshold ?? defaults.txRateMaxPerMin;
    // 0 / negative would mean "any tx is a runaway" → alert storm on
    // misconfig. Abstain instead.
    if (threshold <= 0) return null;

    const since = new Date(now.getTime() - WINDOW_MS).toISOString();

    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, agent.id), gte(agentTransactions.blockTime, since)));

    const total = row?.total ?? 0;
    // No tx in window → no signal. Zero traffic is NOT a runaway; that
    // case belongs to `stale_agent`. We must abstain here to keep the
    // semantic split clean.
    if (total === 0) return null;

    const ratePerMin = total / WINDOW_MINUTES;
    // Strict-greater so a borderline-healthy agent right at the cap does
    // not alert on every tick (same gate as low_balance's `>= threshold`
    // negation).
    if (ratePerMin <= threshold) return null;

    return {
      ruleName: 'tx_rate_anomaly',
      severity: ratePerMin >= threshold * CRITICAL_MULTIPLIER ? 'critical' : 'warning',
      payload: {
        ratePerMin: Math.round(ratePerMin * 100) / 100,
        thresholdPerMin: threshold,
        txCount: total,
        windowMinutes: WINDOW_MINUTES,
      },
      // 5-min-bucket dedupe: same window collapses into one alert (cron
      // runs every 60s, would otherwise fire 5× per bucket). Crossing
      // into the next bucket re-fires — intentional, the user wants to
      // know the loop is still active.
      dedupeKey: `tx_rate_anomaly:${agent.id}:${Math.floor(now.getTime() / WINDOW_MS)}`,
    };
  },
};
