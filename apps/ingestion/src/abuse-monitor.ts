/**
 * Sybil/abuse signup monitor (Epic 14 Phase 3 task 14.16).
 *
 * Runs periodically inside the ingestion worker and alerts the platform
 * owner whenever an abnormal spike of fresh `users` rows lands inside a
 * rolling window. Targets the scenario a sybil attacker would use to
 * sidestep the DB cap (14.14) and the per-IP throttle (14.15) — N fresh
 * Privy accounts minted over a few minutes. The per-user and per-IP
 * caps still enforce limits; this monitor is the tripwire that tells
 * the operator to look.
 *
 * Two cadences are tunable:
 *   - windowMs    : rolling lookback over users.created_at (default 10m)
 *   - checkIntervalMs : how often we evaluate the count (default 5m)
 *
 * The monitor is silent when `TELEGRAM_ADMIN_CHAT_ID` is missing — dev
 * and the test suite don't need an admin chat. Production wires the
 * send function via `index.ts`.
 *
 * Single-instance assumption: cooldown timestamp lives in process heap.
 * Matches the cron's single-worker footprint (see cron.ts); a second
 * pod would re-alert independently until Redis-backed.
 */

import { type Database, users } from '@agentscope/db';
import { gte, sql } from 'drizzle-orm';

export interface AbuseMonitorLogger {
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
}

export interface AbuseMonitorDeps {
  db: Database;
  logger: AbuseMonitorLogger;
  /**
   * Plain-text Telegram send — accepts the already-formatted body and
   * returns when delivery completes. Errors are caught by the caller,
   * so implementations may throw on HTTP failure. Omit to disable
   * alerting without changing shape (the monitor stays a no-op).
   */
  sendAdminMessage?: (text: string) => Promise<void>;
  /** Threshold for the signup spike (default 10). */
  threshold?: number;
  /** Rolling lookback over `users.created_at` (default 10 min). */
  windowMs?: number;
  /** Cooldown between alerts to avoid Telegram spam (default 30 min). */
  cooldownMs?: number;
  /** Tick cadence — how often we run the check (default 5 min). */
  checkIntervalMs?: number;
}

const DEFAULT_THRESHOLD = 10;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Pure cooldown gate. Split out of the runtime so we can unit-test the
 * "fire once, then stay quiet for cooldownMs" policy without spinning
 * up a database or timers.
 *
 * Returns `true` when an alert should fire:
 *   - the spike threshold is met, AND
 *   - either no alert has fired yet (lastAlertAt === null), or the
 *     cooldown window has fully elapsed.
 */
export function shouldAlert(
  count: number,
  threshold: number,
  lastAlertAt: number | null,
  now: number,
  cooldownMs: number,
): boolean {
  if (count < threshold) return false;
  if (lastAlertAt === null) return true;
  // Defensive: a clock that ran backward (NTP correction, mocked test
  // fixtures with reversed timestamps) would otherwise produce a
  // negative delta that trivially clears any cooldown.
  if (now < lastAlertAt) return false;
  return now - lastAlertAt >= cooldownMs;
}

interface MonitorState {
  lastAlertAt: number | null;
}

/**
 * Run one evaluation cycle. Exported for tests to drive the flow
 * without waiting on setInterval.
 */
export async function runAbuseCheck(
  deps: AbuseMonitorDeps,
  state: MonitorState,
  now: number = Date.now(),
): Promise<void> {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const since = new Date(now - windowMs).toISOString();
  const [row] = await deps.db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(users)
    .where(gte(users.createdAt, since));
  const count = row?.count ?? 0;

  if (!shouldAlert(count, threshold, state.lastAlertAt, now, cooldownMs)) {
    return;
  }

  // Short, actionable text — the operator gets enough to decide whether
  // to lock signups, not a full forensic dump.
  const minutes = Math.round(windowMs / 60_000);
  const text = `⚠️ AgentScope abuse signal: ${count} new users in last ${minutes} min`;

  if (!deps.sendAdminMessage) {
    // Sender not configured (no admin chat id) — record that we would
    // have alerted so the cooldown still clamps follow-up no-ops, and
    // surface the signal in logs for dev environments.
    deps.logger.warn({ count, windowMs }, 'abuse signal (no admin chat configured)');
    state.lastAlertAt = now;
    return;
  }

  try {
    await deps.sendAdminMessage(text);
    state.lastAlertAt = now;
    deps.logger.info?.({ count, threshold, windowMs }, 'abuse alert sent');
  } catch (err) {
    // Don't advance `lastAlertAt` on failure — we want the next tick
    // to try again. Retrying is safer than silently suppressing: an
    // actual attack would otherwise go unnoticed if Telegram is down.
    deps.logger.error({ err, count }, 'abuse alert send failed');
  }
}

/**
 * Start the periodic monitor. Returns a `stop()` for graceful shutdown.
 *
 * Skipped entirely when `sendAdminMessage` is absent AND no logger
 * listener is interested — wait, no: we keep it running even without a
 * sender so dev environments still surface the signal via logs.
 */
export function startAbuseMonitor(deps: AbuseMonitorDeps): { stop: () => void } {
  const intervalMs = deps.checkIntervalMs ?? DEFAULT_INTERVAL_MS;
  const state: MonitorState = { lastAlertAt: null };

  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runAbuseCheck(deps, state)
      .catch((err) => {
        try {
          deps.logger.error({ err }, 'abuse monitor tick failed');
        } catch {
          // swallow — logger itself threw; nothing sensible left to do
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

/**
 * Build a minimal plain-text Telegram sender for admin notifications.
 * Kept separate from the agent-alert `createTelegramSender` in
 * `@agentscope/alerter` because that one formats an `AlertMessage`
 * (per-agent fields, severity, etc.) which doesn't match a platform-
 * wide admin ping.
 */
export function createAdminTelegramSender(
  botToken: string,
  chatId: string,
): (text: string) => Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return async (text: string): Promise<void> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`telegram admin send failed: HTTP ${res.status}`);
    }
  };
}
