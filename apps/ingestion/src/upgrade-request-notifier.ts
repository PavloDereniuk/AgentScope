/**
 * Paid-plan request notifier (post-MVP roadmap H.1).
 *
 * The api writes `upgrade_requests` rows and never talks to Telegram. This
 * worker treats rows with `notified_at IS NULL` as an outbox: each tick it
 * sends one admin Telegram message per pending row, then stamps
 * `notified_at`. A Telegram outage leaves the row pending and the next tick
 * retries — a request is delayed, never lost.
 *
 * The stamp is conditional on the `updated_at` we read. If the user revises
 * the request between our read and our stamp, the stamp misses and the next
 * tick sends the revised version instead of silently swallowing it.
 *
 * Without an admin sender (dev / tests without creds) the notifier does
 * nothing and leaves rows pending, so wiring creds later still delivers the
 * backlog.
 */

import { type Database, agents, upgradeRequests, users } from '@agentscope/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

export interface UpgradeRequestNotifierLogger {
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
}

export interface UpgradeRequestNotifierDeps {
  db: Database;
  logger: UpgradeRequestNotifierLogger;
  sendAdminMessage?: (text: string) => Promise<void>;
  /** Tick cadence (default 60 s). */
  checkIntervalMs?: number;
  /** Max rows per tick, so a backlog can't flood the admin chat (default 10). */
  batchSize?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;

export interface PendingUpgradeRequest {
  plan: string;
  contact: string;
  agentCount: number;
  useCase: string;
  privyDid: string;
  currentAgents: number;
}

export function formatUpgradeRequest(r: PendingUpgradeRequest): string {
  return [
    `💸 AgentScope upgrade request: ${r.plan.toUpperCase()}`,
    `Wants: ${r.agentCount} agents (has ${r.currentAgents})`,
    `Contact: ${r.contact}`,
    `User: ${r.privyDid}`,
    '',
    r.useCase,
  ].join('\n');
}

/** Run one outbox pass. Exported so tests can drive it without timers. */
export async function runUpgradeRequestNotify(deps: UpgradeRequestNotifierDeps): Promise<number> {
  if (!deps.sendAdminMessage) return 0;

  const pending = await deps.db
    .select({
      id: upgradeRequests.id,
      updatedAt: upgradeRequests.updatedAt,
      plan: upgradeRequests.plan,
      contact: upgradeRequests.contact,
      agentCount: upgradeRequests.agentCount,
      useCase: upgradeRequests.useCase,
      privyDid: users.privyDid,
      currentAgents: sql<number>`(select cast(count(*) as int) from ${agents} where ${agents.userId} = ${upgradeRequests.userId})`,
    })
    .from(upgradeRequests)
    .innerJoin(users, eq(users.id, upgradeRequests.userId))
    .where(isNull(upgradeRequests.notifiedAt))
    .orderBy(asc(upgradeRequests.updatedAt))
    .limit(deps.batchSize ?? DEFAULT_BATCH_SIZE);

  let sent = 0;
  for (const row of pending) {
    try {
      await deps.sendAdminMessage(formatUpgradeRequest(row));
    } catch (err) {
      // Stop the pass: Telegram is likely down for every row, and the
      // remaining rows stay pending for the next tick.
      deps.logger.error({ err, requestId: row.id }, 'upgrade request notify failed');
      break;
    }
    await deps.db
      .update(upgradeRequests)
      .set({ notifiedAt: sql`now()` })
      .where(and(eq(upgradeRequests.id, row.id), eq(upgradeRequests.updatedAt, row.updatedAt)));
    sent += 1;
  }

  if (sent > 0) deps.logger.info?.({ sent }, 'upgrade requests notified');
  return sent;
}

/** Start the periodic notifier. Returns a `stop()` for graceful shutdown. */
export function startUpgradeRequestNotifier(deps: UpgradeRequestNotifierDeps): {
  stop: () => void;
} {
  const intervalMs = deps.checkIntervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runUpgradeRequestNotify(deps)
      .catch((err) => {
        try {
          deps.logger.error({ err }, 'upgrade request notifier tick failed');
        } catch {
          // logger itself threw; nothing sensible left to do
        }
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
