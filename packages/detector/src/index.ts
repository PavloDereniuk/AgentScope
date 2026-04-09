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

export { slippageRule } from './rules/slippage';
