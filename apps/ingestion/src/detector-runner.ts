/**
 * Detector runner (task 5.9).
 *
 * After each successful tx persist, evaluates tx-triggered rules
 * (slippage_spike, gas_spike) and inserts alert rows for any that fire.
 *
 * The runner fetches the agent's alert_rules thresholds from DB so each
 * rule can use per-agent overrides. Rule errors are caught and logged
 * by the evaluator — they never crash the ingestion pipeline.
 */

import { type Database, agents, alerts } from '@agentscope/db';
import {
  type DefaultThresholds,
  type TxRuleDef,
  type TxSnapshot,
  evaluateTx,
  gasRule,
  slippageRule,
} from '@agentscope/detector';
import type { EvalLogger } from '@agentscope/detector';
import type { AlertRuleThresholds } from '@agentscope/shared';
import { eq } from 'drizzle-orm';

/** All tx-triggered rules, evaluated after each persist. */
const TX_RULES: readonly TxRuleDef[] = [slippageRule, gasRule];

export interface DetectorDeps {
  db: Database;
  logger: EvalLogger;
  defaults: DefaultThresholds;
}

/**
 * Run tx-triggered detector rules for a just-persisted transaction.
 * Inserts alert rows for any rules that fire. Returns the count of
 * alerts created.
 */
export async function runTxDetector(
  deps: DetectorDeps,
  agentId: string,
  transaction: TxSnapshot,
): Promise<number> {
  // Fetch agent's per-rule thresholds.
  const [agent] = await deps.db
    .select({ alertRules: agents.alertRules })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const alertRules = (agent?.alertRules ?? {}) as AlertRuleThresholds;

  const results = await evaluateTx(
    TX_RULES,
    {
      agent: { id: agentId, alertRules },
      defaults: deps.defaults,
      db: deps.db,
      now: new Date(),
      transaction,
    },
    deps.logger,
  );

  if (results.length === 0) return 0;

  await deps.db.insert(alerts).values(
    results.map((r) => ({
      agentId,
      ruleName: r.ruleName,
      severity: r.severity,
      payload: r.payload,
      dedupeKey: r.dedupeKey ?? null,
    })),
  );

  return results.length;
}
