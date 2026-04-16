/**
 * Slippage spike rule (task 5.4).
 *
 * Fires when a Jupiter swap's slippage tolerance (`slippageBps` from
 * the parser's parsedArgs) exceeds the configured threshold. The
 * threshold is read from per-agent overrides first, then falls back to
 * the global default.
 *
 * Severity escalates from warning → critical when the actual slippage
 * exceeds 5× the threshold.
 */

import type { RuleResult, TxRuleDef } from '../types';

/** Multiplier at which severity escalates from warning to critical. */
const CRITICAL_MULTIPLIER = 5;

export const slippageRule: TxRuleDef = {
  name: 'slippage_spike',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, defaults } = ctx;

    // Only applies to the canonical Jupiter swap instruction.
    // Matching the exact name avoids false positives on jupiter.unknown (unrecognised discriminators).
    if (transaction.instructionName !== 'jupiter.swap') return null;

    const args = transaction.parsedArgs;
    if (!args || typeof args.slippageBps !== 'number') return null;

    // A negative slippageBps value is a parser anomaly — skip rather than
    // firing a false alert (negative slippage would trivially pass the check).
    if (args.slippageBps < 0) return null;

    const actualPct = args.slippageBps / 100;
    const thresholdPct = agent.alertRules.slippagePctThreshold ?? defaults.slippagePct;

    if (actualPct <= thresholdPct) return null;

    // A zero threshold means every swap looks critical (0 * 5 = 0). Guard
    // explicitly so a misconfigured agent doesn't produce constant alerts.
    if (thresholdPct <= 0) return null;

    const severity = actualPct >= thresholdPct * CRITICAL_MULTIPLIER ? 'critical' : 'warning';

    return {
      ruleName: 'slippage_spike',
      severity,
      payload: {
        actualPct,
        thresholdPct,
        signature: transaction.signature,
      },
      dedupeKey: `slippage:${transaction.signature}`,
    };
  },
};
