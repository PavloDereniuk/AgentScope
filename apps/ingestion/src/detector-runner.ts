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

import type { AlertMessage, DeliverDeps } from '@agentscope/alerter';
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
  /** When set, alerts are delivered via the alerter after DB insert. */
  alerter?: DeliverDeps;
  /** Optional callback to publish SSE events to the API (6.15). */
  publishEvent?: (event: { type: string; agentId: string; [key: string]: unknown }) => void;
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
  // Fetch agent's name + per-rule thresholds.
  const [agent] = await deps.db
    .select({ alertRules: agents.alertRules, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const alertRules = (agent?.alertRules ?? {}) as AlertRuleThresholds;
  const agentName = agent?.name ?? 'Unknown Agent';

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

  const inserted = await deps.db
    .insert(alerts)
    .values(
      results.map((r) => ({
        agentId,
        ruleName: r.ruleName,
        severity: r.severity,
        payload: r.payload,
        dedupeKey: r.dedupeKey ?? null,
      })),
    )
    .returning({ id: alerts.id, triggeredAt: alerts.triggeredAt });

  // Publish alert.new events for SSE (6.15).
  for (const row of inserted) {
    if (!row) continue;
    deps.publishEvent?.({
      type: 'alert.new',
      agentId,
      alertId: row.id,
      severity: results[inserted.indexOf(row)]?.severity ?? 'info',
      at: row.triggeredAt,
    });
  }

  // Deliver alerts via configured channels (5.14).
  if (deps.alerter) {
    const { deliver } = await import('@agentscope/alerter');
    for (let i = 0; i < inserted.length; i++) {
      const row = inserted[i];
      const result = results[i];
      if (!row || !result) continue;

      const msg: AlertMessage = {
        id: row.id,
        agentId,
        agentName,
        ruleName: result.ruleName,
        severity: result.severity,
        payload: result.payload,
        triggeredAt: row.triggeredAt,
      };

      try {
        const delivery = await deliver(deps.alerter, msg, 'telegram');
        if (delivery.success) {
          await deps.db
            .update(alerts)
            .set({
              deliveredAt: new Date().toISOString(),
              deliveryChannel: 'telegram',
              deliveryStatus: 'delivered',
            })
            .where(eq(alerts.id, row.id));
        } else {
          await deps.db
            .update(alerts)
            .set({
              deliveryStatus: 'failed',
              deliveryError: delivery.error ?? 'unknown',
            })
            .where(eq(alerts.id, row.id));
        }
      } catch (err) {
        deps.logger.error({ err, alertId: row.id }, 'alert delivery failed');
      }
    }
  }

  return results.length;
}
