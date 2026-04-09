/**
 * Rule evaluator (task 5.2).
 *
 * Two entry points:
 *   - `evaluateTx(rules, ctx)` — runs tx-triggered rules (slippage, gas)
 *   - `evaluateCron(rules, ctx)` — runs cron-triggered rules (drawdown, error_rate, stale)
 *
 * Both iterate the registered rules, call `evaluate`, collect non-null
 * results, and return them as an array. A rule that throws is caught
 * and logged — it does not prevent other rules from running.
 */

import type { CronRuleContext, CronRuleDef, RuleResult, TxRuleContext, TxRuleDef } from './types';

export interface EvalLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Evaluate all tx-triggered rules. Returns results for rules that fired. */
export async function evaluateTx(
  rules: readonly TxRuleDef[],
  ctx: TxRuleContext,
  logger?: EvalLogger,
): Promise<RuleResult[]> {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    try {
      const result = await rule.evaluate(ctx);
      if (result) results.push(result);
    } catch (err) {
      logger?.error({ rule: rule.name, err }, 'tx rule evaluation failed');
    }
  }
  return results;
}

/** Evaluate all cron-triggered rules. Returns results for rules that fired. */
export async function evaluateCron(
  rules: readonly CronRuleDef[],
  ctx: CronRuleContext,
  logger?: EvalLogger,
): Promise<RuleResult[]> {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    try {
      const result = await rule.evaluate(ctx);
      if (result) results.push(result);
    } catch (err) {
      logger?.error({ rule: rule.name, err }, 'cron rule evaluation failed');
    }
  }
  return results;
}
