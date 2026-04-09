/**
 * Periodic cron evaluator for time-based detector rules (task 5.10).
 *
 * Every `intervalMs` (default 60s), fetches all agents and evaluates
 * cron-triggered rules (drawdown, error_rate, stale_agent) for each.
 * Alerts are inserted into the DB for any rules that fire.
 *
 * The cron runs in the same process as the ingestion worker — no
 * separate deployment needed for MVP.
 */

import { type Database, agents, alerts } from '@agentscope/db';
import {
  type CronRuleDef,
  type DefaultThresholds,
  drawdownRule,
  errorRateRule,
  evaluateCron,
  staleRule,
} from '@agentscope/detector';
import type { EvalLogger } from '@agentscope/detector';
import type { AlertRuleThresholds } from '@agentscope/shared';

const CRON_RULES: readonly CronRuleDef[] = [drawdownRule, errorRateRule, staleRule];

export interface CronDeps {
  db: Database;
  logger: EvalLogger;
  defaults: DefaultThresholds;
  intervalMs?: number;
}

/**
 * Run one evaluation cycle for all agents. Exported for testing.
 */
export async function runCronCycle(deps: CronDeps): Promise<number> {
  const allAgents = await deps.db
    .select({ id: agents.id, alertRules: agents.alertRules })
    .from(agents);

  const now = new Date();
  let totalAlerts = 0;

  for (const agent of allAgents) {
    const alertRules = (agent.alertRules ?? {}) as AlertRuleThresholds;

    const results = await evaluateCron(
      CRON_RULES,
      {
        agent: { id: agent.id, alertRules },
        defaults: deps.defaults,
        db: deps.db,
        now,
      },
      deps.logger,
    );

    if (results.length > 0) {
      await deps.db.insert(alerts).values(
        results.map((r) => ({
          agentId: agent.id,
          ruleName: r.ruleName,
          severity: r.severity,
          payload: r.payload,
          dedupeKey: r.dedupeKey ?? null,
        })),
      );
      totalAlerts += results.length;
    }
  }

  return totalAlerts;
}

/**
 * Start the periodic cron. Returns a stop function for graceful shutdown.
 */
export function startCron(deps: CronDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? 60_000;

  const timer = setInterval(() => {
    runCronCycle(deps).catch((err) => {
      deps.logger.error({ err }, 'cron cycle failed');
    });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
