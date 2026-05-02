/**
 * @agentscope/detector — rule-based anomaly detection.
 *
 * Exports types (5.1), evaluator (5.2), and individual rules (5.3-5.8).
 */

export type {
  AgentSnapshot,
  CronRuleContext,
  CronRuleDef,
  DefaultThresholds,
  RuleResult,
  TxRuleContext,
  TxRuleDef,
  TxSnapshot,
} from './types';

export type { EvalLogger } from './evaluate';
export { evaluateCron, evaluateTx } from './evaluate';

export { decisionSwapMismatchRule } from './rules/decision-swap-mismatch';
export { drawdownRule } from './rules/drawdown';
export { errorRateRule } from './rules/error-rate';
export { gasRule } from './rules/gas';
export { ghostExecutionRule } from './rules/ghost-execution';
export { slippageRule } from './rules/slippage';
export { staleOracleRule } from './rules/stale-oracle';
export { staleRule } from './rules/stale';
