/**
 * Detector runner (task 5.9 + Epic 14 per-agent routing).
 *
 * After each successful tx persist, evaluates tx-triggered rules
 * (slippage_spike, gas_spike) and inserts alert rows for any that fire.
 *
 * Routing (Epic 14): the channel picked per message is
 *   webhook > telegram > skip
 * based on the owning agent's `webhookUrl` / `telegramChatId` columns.
 * A webhook sender is constructed lazily per unique URL so we don't pay
 * URL-validation cost on every delivery.
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
  type DefaultThresholds,
  type TxRuleDef,
  type TxSnapshot,
  evaluateTx,
  gasRule,
  slippageRule,
} from '@agentscope/detector';
import type { EvalLogger } from '@agentscope/detector';
import type { AlertRuleThresholds, DeliveryChannel } from '@agentscope/shared';
import { eq } from 'drizzle-orm';

/** All tx-triggered rules, evaluated after each persist. */
const TX_RULES: readonly TxRuleDef[] = [slippageRule, gasRule];

/**
 * Stable composite key for RuleResult ↔ inserted-row correlation.
 * Null dedupeKey is legal for rules that opt out of dedupe; without the
 * rule-name prefix, two different rules both emitting null collide into
 * a single Map slot and the second result steals the first's row.
 */
function correlationKey(ruleName: string, dedupeKey: string | null): string {
  return `${ruleName}:${dedupeKey ?? ''}`;
}

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
 * Pick the delivery channel for one agent. `webhook > telegram > skip`.
 *
 * Webhook senders are constructed inline per-agent (URL is part of the
 * agent row), so we don't require `alerter.webhook` to be pre-wired — a
 * non-null webhookUrl is sufficient. Telegram falls back only if the
 * runner was given a `telegram` sender at startup. Returns null when no
 * channel is deliverable, leaving the row in the default
 * `delivery_status = 'pending'` state.
 */
function pickChannel(alerter: DeliverDeps, webhookUrl: string | null): DeliveryChannel | null {
  if (webhookUrl) return 'webhook';
  if (alerter.telegram) return 'telegram';
  return null;
}

/**
 * Build or reuse a webhook sender for a given URL. Senders are cheap but
 * URL validation runs at construction time; caching keeps the per-tick
 * cost constant when the same agent fires multiple rules.
 */
function webhookSenderFor(
  url: string,
  cache: Map<string, ReturnType<typeof createWebhookSender>>,
): ReturnType<typeof createWebhookSender> {
  const existing = cache.get(url);
  if (existing) return existing;
  const sender = createWebhookSender({ url });
  cache.set(url, sender);
  return sender;
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
  // Fetch agent's name + per-rule thresholds + per-agent routing (Epic 14).
  const [agent] = await deps.db
    .select({
      alertRules: agents.alertRules,
      name: agents.name,
      telegramChatId: agents.telegramChatId,
      webhookUrl: agents.webhookUrl,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const alertRules = (agent?.alertRules ?? {}) as AlertRuleThresholds;
  const agentName = agent?.name ?? 'Unknown Agent';
  const telegramChatId = agent?.telegramChatId ?? null;
  const webhookUrl = agent?.webhookUrl ?? null;

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
    // Dedupe at the DB level: slippage/gas rules key on tx signature, so a
    // replayed tx (e.g. WS redelivery) must not produce a duplicate alert.
    // `target` must match the UNIQUE index from migration 0004.
    .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] })
    // Include ruleName + dedupeKey in RETURNING so we can correlate inserted
    // rows back to their RuleResult by a composite key instead of relying on
    // array-index order (which is not guaranteed to be stable when
    // onConflictDoNothing skips rows). Keying on dedupeKey alone collapses
    // two different rules that both emit a null key into the same slot.
    // DO NOT remove `ruleName` or `dedupeKey` from the projection below —
    // correlationKey() depends on both and silently mis-correlates if either
    // becomes `undefined`.
    .returning({
      id: alerts.id,
      triggeredAt: alerts.triggeredAt,
      ruleName: alerts.ruleName,
      dedupeKey: alerts.dedupeKey,
    });

  const insertedByKey = new Map(
    inserted.map((row) => [correlationKey(row.ruleName, row.dedupeKey), row]),
  );

  // Publish alert.new events for SSE (6.15).
  for (const result of results) {
    const row = insertedByKey.get(correlationKey(result.ruleName, result.dedupeKey ?? null));
    if (!row) continue;
    deps.publishEvent?.({
      type: 'alert.new',
      agentId,
      alertId: row.id,
      severity: result.severity,
      at: row.triggeredAt,
    });
  }

  // Deliver alerts via configured channels. Each delivery is isolated with
  // its own try/catch so one channel failure does not block other alerts,
  // and we await all deliveries in parallel via Promise.all to avoid
  // sequential latency and ensure every DB update completes before the
  // function returns (no orphaned pending writes).
  if (deps.alerter) {
    const alerter = deps.alerter;
    const channel = pickChannel(alerter, webhookUrl);
    if (!channel) return results.length;

    // Build a per-agent alerter view: for webhook we swap in a sender
    // bound to *this* agent's URL so deliver() doesn't need to know about
    // per-agent routing.
    const webhookCache = new Map<string, ReturnType<typeof createWebhookSender>>();
    const perAgentDeps: DeliverDeps = {
      ...(alerter.telegram ? { telegram: alerter.telegram } : {}),
      ...(channel === 'webhook' && webhookUrl
        ? { webhook: webhookSenderFor(webhookUrl, webhookCache) }
        : {}),
    };

    await Promise.all(
      results.map(async (result) => {
        const row = insertedByKey.get(correlationKey(result.ruleName, result.dedupeKey ?? null));
        if (!row) return;

        const msg: AlertMessage = {
          id: row.id,
          agentId,
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
          deps.logger.error({ err, alertId: row.id }, 'alert delivery failed');
        }
      }),
    );
  }

  return results.length;
}
