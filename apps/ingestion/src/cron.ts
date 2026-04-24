/**
 * Periodic cron evaluator for time-based detector rules (task 5.10).
 *
 * Every `intervalMs` (default 60s), fetches all agents and evaluates
 * cron-triggered rules (drawdown, error_rate, stale_agent) for each.
 * Alerts are inserted into the DB, published on the SSE bus, and
 * delivered via the configured alerter (mirrors detector-runner.ts).
 *
 * The cron runs in the same process as the ingestion worker — no
 * separate deployment needed for MVP.
 */

import {
  type AlertMessage,
  type DeliverDeps,
  type DeliveryResult,
  createWebhookSender,
  deliver,
} from '@agentscope/alerter';
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
import type { AlertRuleThresholds, DeliveryChannel } from '@agentscope/shared';
import { and, eq, ne } from 'drizzle-orm';

/**
 * Cron-local logger: EvalLogger (used by evaluateCron) plus warn/info for
 * cadence messages emitted outside the rule loop. pino satisfies this
 * structurally.
 */
interface CronLogger extends EvalLogger {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
}

/**
 * Stable composite key for RuleResult ↔ inserted-row correlation.
 * Null dedupeKey is legal for rules that opt out of dedupe; without the
 * rule-name prefix, two different rules both emitting null collide into
 * a single Map slot and the second result steals the first's row.
 */
function correlationKey(ruleName: string, dedupeKey: string | null): string {
  return `${ruleName}:${dedupeKey ?? ''}`;
}

const CRON_RULES: readonly CronRuleDef[] = [drawdownRule, errorRateRule, staleRule];

/**
 * Pick the delivery channel for one agent. `webhook > telegram > skip`.
 *
 * Webhook senders are constructed inline per-agent (URL is part of the
 * agent row), so we don't require `alerter.webhook` to be pre-wired — a
 * non-null webhookUrl is sufficient. Telegram is picked only when the
 * agent has its own `telegramChatId` (multi-tenant safety: no silent
 * fallback to a deployer-wide default — that would re-route a new user's
 * alerts into the platform owner's chat). Returns null when no channel
 * is deliverable, leaving the row in the default
 * `delivery_status = 'pending'` state.
 */
function pickChannel(
  alerter: DeliverDeps,
  webhookUrl: string | null,
  telegramChatId: string | null,
): DeliveryChannel | null {
  if (webhookUrl) return 'webhook';
  if (alerter.telegram && telegramChatId) return 'telegram';
  return null;
}

export interface CronDeps {
  db: Database;
  logger: CronLogger;
  defaults: DefaultThresholds;
  intervalMs?: number;
  /** When set, alerts are delivered via the alerter after DB insert. */
  alerter?: DeliverDeps;
  /** Optional callback to publish SSE events to the API (6.15). */
  publishEvent?: (event: { type: string; agentId: string; [key: string]: unknown }) => void;
}

/**
 * Run one evaluation cycle for all agents. Exported for testing.
 */
export async function runCronCycle(deps: CronDeps): Promise<number> {
  const allAgents = await deps.db
    .select({
      id: agents.id,
      name: agents.name,
      userId: agents.userId,
      alertRules: agents.alertRules,
      telegramChatId: agents.telegramChatId,
      webhookUrl: agents.webhookUrl,
    })
    .from(agents);

  // Shared across the whole cycle: webhook senders are expensive to
  // reconstruct (they parse-validate the URL) and the same agent URL
  // typically fires multiple rules per tick. Scoped per-cycle so stale
  // senders don't leak if an agent later rotates its webhookUrl.
  const webhookCache = new Map<string, ReturnType<typeof createWebhookSender>>();

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

    if (results.length === 0) continue;

    // onConflictDoNothing prevents alert storms: if the same dedupeKey
    // fires on every 60s cycle (e.g. persistent drawdown), only the
    // first insert goes through — subsequent cycles are no-ops. The
    // `target` must match the UNIQUE index on (agent_id, rule_name,
    // dedupe_key) from migration 0004; without it Postgres has no
    // constraint to match and every tick inserts a duplicate row.
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
      .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] })
      // Return ruleName + dedupeKey so we can correlate inserted rows back to
      // their RuleResult via a composite key instead of relying on
      // array-index order (unstable under onConflictDoNothing) or on
      // dedupeKey alone (null keys from two different rules collide).
      // DO NOT remove `ruleName` or `dedupeKey` from the projection below —
      // correlationKey() depends on both.
      .returning({
        id: alerts.id,
        triggeredAt: alerts.triggeredAt,
        ruleName: alerts.ruleName,
        dedupeKey: alerts.dedupeKey,
      });

    totalAlerts += inserted.length;

    // Mirror the stale_agent rule into agents.status so the dashboard
    // list view ("stale" badge) matches alert state. The inverse
    // transition (stale → live) is handled in persistTx when a fresh
    // tx arrives. Checked against evaluateCron results (not `inserted`)
    // so the flip still happens on cycles where the dedupe key already
    // exists but the underlying condition is ongoing.
    // Guard with `status != 'stale'` so an already-stale agent does
    // not re-write the row (and touch updated_at triggers) every tick.
    if (results.some((r) => r.ruleName === 'stale_agent')) {
      await deps.db
        .update(agents)
        .set({ status: 'stale' })
        .where(and(eq(agents.id, agent.id), ne(agents.status, 'stale')));
    }

    // Skip publish + deliver for rows that were deduped (already exist).
    if (inserted.length === 0) continue;

    const insertedByKey = new Map(
      inserted.map((row) => [correlationKey(row.ruleName, row.dedupeKey), row]),
    );

    // Publish alert.new on the SSE bus so dashboards refresh live.
    // 13.13 added the per-user fan-out channel, so include userId.
    for (const result of results) {
      const row = insertedByKey.get(correlationKey(result.ruleName, result.dedupeKey ?? null));
      if (!row) continue;
      deps.publishEvent?.({
        type: 'alert.new',
        agentId: agent.id,
        userId: agent.userId,
        alertId: row.id,
        severity: result.severity,
        at: row.triggeredAt,
      });
    }

    // Deliver via per-agent channel (Epic 14: webhook > telegram > skip).
    // Each delivery is isolated — one channel failure must not block
    // others. Mirrors the pattern used in detector-runner.ts.
    if (deps.alerter) {
      const alerter = deps.alerter;
      const agentName = agent.name;
      const telegramChatId = agent.telegramChatId ?? null;
      const webhookUrl = agent.webhookUrl ?? null;
      const channel = pickChannel(alerter, webhookUrl, telegramChatId);

      if (channel) {
        const perAgentDeps: DeliverDeps = {
          ...(alerter.telegram ? { telegram: alerter.telegram } : {}),
          ...(channel === 'webhook' && webhookUrl
            ? {
                webhook: (() => {
                  const cached = webhookCache.get(webhookUrl);
                  if (cached) return cached;
                  const sender = createWebhookSender({ url: webhookUrl });
                  webhookCache.set(webhookUrl, sender);
                  return sender;
                })(),
              }
            : {}),
        };

        await Promise.all(
          results.map(async (result) => {
            const row = insertedByKey.get(
              correlationKey(result.ruleName, result.dedupeKey ?? null),
            );
            if (!row) return;

            const msg: AlertMessage = {
              id: row.id,
              agentId: agent.id,
              agentName,
              ruleName: result.ruleName,
              severity: result.severity,
              payload: result.payload,
              triggeredAt: row.triggeredAt,
              ...(telegramChatId ? { chatId: telegramChatId } : {}),
              ...(webhookUrl ? { webhookUrl } : {}),
            };

            try {
              const delivery: DeliveryResult = await deliver(perAgentDeps, msg, channel);
              if (delivery.success) {
                await deps.db
                  .update(alerts)
                  .set({
                    deliveredAt: new Date().toISOString(),
                    deliveryChannel: channel,
                    deliveryStatus: 'delivered',
                  })
                  .where(eq(alerts.id, row.id));
              } else {
                await deps.db
                  .update(alerts)
                  .set({
                    deliveryStatus: 'failed',
                    deliveryChannel: channel,
                    deliveryError: delivery.error ?? 'unknown',
                  })
                  .where(eq(alerts.id, row.id));
              }
            } catch (err) {
              deps.logger.error({ err, alertId: row.id }, 'cron alert delivery failed');
            }
          }),
        );
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

  // Prevent overlapping cycles: if a cycle takes longer than intervalMs
  // (e.g. DB is slow), the next tick should skip rather than pile on DB
  // locks. At MVP agent counts a cycle is tens of ms, so skips are rare;
  // still a cheap safety net.
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      deps.logger.warn('cron cycle skipped — previous cycle still running');
      return;
    }
    running = true;
    // Double-wrap: runCronCycle().catch() handles rejections from the promise
    // chain, and the outer try/catch protects against synchronous throws in
    // catch() handlers themselves. Without this, one bad handler error would
    // surface as an uncaughtException and kill the process.
    try {
      runCronCycle(deps)
        .catch((err) => {
          try {
            deps.logger.error({ err }, 'cron cycle failed');
          } catch {
            // swallow — nothing sensible to do if the logger itself throws
          }
        })
        .finally(() => {
          running = false;
        });
    } catch (err) {
      running = false;
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
