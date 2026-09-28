/**
 * Low wallet balance rule (post-MVP roadmap A.2, v0.4.1).
 *
 * Fires when the agent's wallet SOL balance drops below the warning
 * threshold. Cron-triggered — evaluated every 60s cycle, alerts at most
 * once a day per severity (see dedupeKey). The balance lookup is injected via `fetchAgentBalance` so unit tests can
 * stub it and the rule stays RPC-agnostic; the ingestion layer wires
 * the real Helius `Connection.getBalance` with a per-wallet TTL cache.
 *
 * Three abstain conditions return null instead of alerting:
 *   1. Fetcher unwired (e.g. tx-runner path) — rule does nothing.
 *   2. Wallet pubkey missing from the agent snapshot — same.
 *   3. Fetcher returns null OR throws — RPC failure must not silently
 *      flag the agent as low (false-positive worse than missed alert).
 *
 * Critical threshold is one-fifth of warning. Picked so the default
 * 0.005 SOL warning escalates at 0.001 SOL — the practical floor where
 * the next priority-fee bump or rent payment would brick the agent.
 */

import type { CronRuleDef, RuleResult } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const CRITICAL_DIVIDER = 5;

export const lowBalanceRule: CronRuleDef = {
  name: 'low_balance',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, now, fetchAgentBalance } = ctx;
    const threshold = agent.alertRules.lowBalanceSolThreshold ?? defaults.lowBalanceSol;
    if (threshold <= 0) return null;
    if (!fetchAgentBalance) return null;
    if (!agent.walletPubkey) return null;

    let balanceSol: number | null;
    try {
      balanceSol = await fetchAgentBalance(agent.walletPubkey);
    } catch {
      return null;
    }
    if (balanceSol == null) return null;
    if (balanceSol >= threshold) return null;

    const criticalThreshold = threshold / CRITICAL_DIVIDER;
    const severity = balanceSol < criticalThreshold ? 'critical' : 'warning';

    return {
      ruleName: 'low_balance',
      severity,
      payload: {
        balanceSol,
        thresholdSol: threshold,
        criticalThresholdSol: criticalThreshold,
      },
      // Daily dedupe — a drained wallet stays drained until someone tops it
      // up, and an hourly window re-fired 24×/day. onConflictDoNothing on
      // (agent_id, rule_name, dedupe_key) collapses subsequent inserts.
      // Severity is part of the key so warning → critical still escalates
      // the same day.
      dedupeKey: `low_balance:${agent.id}:${severity}:${Math.floor(now.getTime() / DAY_MS)}`,
    };
  },
};
