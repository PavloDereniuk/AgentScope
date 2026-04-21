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
import { eq } from 'drizzle-orm';

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
      // onConflictDoNothing prevents alert storms: if the same dedupeKey
      // fires on every 60s cycle (e.g. persistent drawdown), only the
      // first insert goes through — subsequent cycles are no-ops.
      const inserted = await deps.db
        .insert(alerts)
        .values(
          results.map((r) => ({
            agentId: agent.id,
            ruleName: r.ruleName,
            severity: r.severity,
            payload: r.payload,
            dedupeKey: r.dedupeKey ?? null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: alerts.id });
      totalAlerts += inserted.length;

      // Mirror the stale_agent rule into agents.status so the dashboard
      // list view ("stale" badge) matches alert state. The inverse
      // transition (stale → live) is handled in persistTx when a fresh
      // tx arrives. Checked against evaluateCron results (not `inserted`)
      // so the flip still happens on cycles where the dedupe key already
      // exists but the underlying condition is ongoing.
      if (results.some((r) => r.ruleName === 'stale_agent')) {
        await deps.db.update(agents).set({ status: 'stale' }).where(eq(agents.id, agent.id));
      }
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
    // Double-wrap: runCronCycle().catch() handles rejections from the promise
    // chain, and the outer try/catch protects against synchronous throws in
    // catch() handlers themselves. Without this, one bad handler error would
    // surface as an uncaughtException and kill the process.
    try {
      runCronCycle(deps).catch((err) => {
        try {
          deps.logger.error({ err }, 'cron cycle failed');
        } catch {
          // swallow — nothing sensible to do if the logger itself throws
        }
      });
    } catch (err) {
      try {
        deps.logger.error({ err }, 'cron setInterval tick threw synchronously');
      } catch {
        // swallow — see above
      }
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
