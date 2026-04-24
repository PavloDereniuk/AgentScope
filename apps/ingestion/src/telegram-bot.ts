/**
 * Telegram bot long-polling worker (task 14.10).
 *
 * Resolves the `/start <code>` deep-link flow that lets a user link
 * their Telegram chat to AgentScope without copy-pasting their
 * numeric chat_id. The dashboard (14.12) creates a binding via
 * POST /api/telegram/init, hands the user a t.me/<bot>?start=<code>
 * URL, and polls /api/telegram/status until linked.
 *
 * Why long-polling and not webhooks?
 *  - No public HTTPS endpoint required → works on Railway free without
 *    a separate ingress. Webhooks would force us to publish a domain
 *    *just for Telegram callbacks*, which costs nothing today but adds
 *    one more moving part to monitor.
 *  - Telegram allows a single consumer per bot — long-poll OR webhook,
 *    not both. We `deleteWebhook` on startup defensively in case a
 *    previous experiment left one configured (otherwise getUpdates
 *    returns 409 Conflict).
 *  - Single-instance assumption: if the ingestion worker is ever scaled
 *    horizontally on Railway, two pods would both call getUpdates and
 *    race for update_id ownership. Acceptable trade-off at MVP scale;
 *    revisit when scaling out.
 *
 * Native fetch only — keeping the worker dep-free was a hard rule for
 * Phase 2 (no new runtime deps after Week 1).
 */

import { type Database, telegramBindings } from '@agentscope/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from './logger';

export interface TelegramBotDeps {
  db: Database;
  botToken: string;
  logger: Logger;
  /**
   * getUpdates long-poll timeout (sec). Telegram caps at 50; 30 is the
   * sweet spot — long enough to absorb idle traffic, short enough that
   * SIGTERM cancels promptly via AbortController.
   */
  pollTimeoutSec?: number;
  /**
   * Window during which a freshly-issued binding code is still valid.
   * Older unlinked rows are ignored at lookup time and pruned by the
   * janitor cron. Default 10 min — matches docs/TASKS.md 14.9.
   */
  bindingTtlMin?: number;
  /** Janitor sweep interval (ms). Default 5 min. */
  janitorIntervalMs?: number;
}

export interface TelegramBot {
  stop: () => Promise<void>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
}

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const DEFAULT_BINDING_TTL_MIN = 10;
const DEFAULT_JANITOR_INTERVAL_MS = 5 * 60_000;

/**
 * Result of processing a single update. Exported for test assertions
 * and for the unit harness (no need to round-trip through fetch).
 */
export interface UpdateResult {
  /** True when the update matched a /start <code> with a live binding. */
  linked: boolean;
  /** Plain reply text the bot should send, or undefined to stay silent. */
  replyText?: string;
  /** Chat to reply into, or undefined when there's nothing to send. */
  replyChatId?: number;
}

/**
 * Pure handler for one Telegram update — exported so tests can drive
 * it with a fabricated payload instead of stubbing the entire fetch
 * layer. Returns a description of what the bot should do next; the
 * caller is responsible for actually sending the reply.
 */
export async function processUpdate(
  db: Database,
  update: TelegramUpdate,
  bindingTtlMin: number,
  logger: Logger,
): Promise<UpdateResult> {
  const msg = update.message;
  if (!msg || !msg.text) return { linked: false };
  // Private chats only — group bindings would link the wrong person.
  if (msg.chat.type !== 'private') return { linked: false };

  const text = msg.text.trim();
  const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
  if (!startMatch) return { linked: false };

  const code = startMatch[1];
  if (!code) {
    return {
      linked: false,
      replyChatId: msg.chat.id,
      replyText:
        'Welcome to AgentScope. Open the dashboard → Settings → "Link Telegram" to generate a one-time link.',
    };
  }

  const ttlCutoff = new Date(Date.now() - bindingTtlMin * 60_000).toISOString();
  // Lookup with TTL gate: an expired unlinked row stays in the table
  // until the janitor runs, but we treat it as not-found here so the
  // user gets the same UX as if it were already pruned.
  const [binding] = await db
    .select()
    .from(telegramBindings)
    .where(
      and(
        eq(telegramBindings.bindingCode, code),
        // Either still in TTL OR already linked (idempotent re-tap).
        sql`(${telegramBindings.linkedAt} IS NOT NULL OR ${telegramBindings.createdAt} > ${ttlCutoff})`,
      ),
    )
    .limit(1);

  if (!binding) {
    logger.info({ code: code.slice(0, 6) }, 'telegram bot: unknown or expired binding code');
    return {
      linked: false,
      replyChatId: msg.chat.id,
      replyText:
        'This link has expired or is invalid. Generate a new one from AgentScope → Settings.',
    };
  }

  const newChatId = String(msg.chat.id);

  if (binding.linkedAt) {
    // Already linked: idempotent reply, but if the stored chat differs
    // (rare — same code claimed twice from different chats) we do NOT
    // overwrite — first claim wins, second user gets a clear refusal.
    if (binding.chatId === newChatId) {
      return {
        linked: true,
        replyChatId: msg.chat.id,
        replyText: 'Already linked. Alerts are flowing to this chat.',
      };
    }
    return {
      linked: false,
      replyChatId: msg.chat.id,
      replyText: 'This link has already been used by another Telegram account.',
    };
  }

  await db
    .update(telegramBindings)
    .set({ chatId: newChatId, linkedAt: new Date().toISOString() })
    .where(eq(telegramBindings.id, binding.id));

  logger.info({ userId: binding.userId, chatId: newChatId }, 'telegram bot: chat linked');
  return {
    linked: true,
    replyChatId: msg.chat.id,
    replyText: 'Linked. Go back to AgentScope to finish setup.',
  };
}

/**
 * Delete stale unlinked bindings so the unique-on-binding_code index
 * doesn't fill with garbage. Returns the row count deleted.
 *
 * Linked rows are kept indefinitely — they record provenance for the
 * agents.telegram_chat_id values the dashboard wrote into the agents
 * table, and there's no PII concern (the chat_id is already on agents).
 */
export async function pruneExpiredBindings(db: Database, ttlMin: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMin * 60_000).toISOString();
  const deleted = await db
    .delete(telegramBindings)
    .where(and(isNull(telegramBindings.linkedAt), lt(telegramBindings.createdAt, cutoff)))
    .returning({ id: telegramBindings.id });
  return deleted.length;
}

/**
 * Send a plain-text Telegram reply. Best-effort: errors are logged
 * but never propagate — a failed reply must not stop the long-poll
 * loop, otherwise one bad chat (e.g. user blocked the bot) would
 * deafen the bot to every other user.
 */
async function sendReply(
  botToken: string,
  chatId: number,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'telegram bot: reply failed');
    }
  } catch (err) {
    logger.warn({ err }, 'telegram bot: reply fetch threw');
  }
}

/**
 * Start the bot worker. Returns a stop() that resolves when the
 * in-flight getUpdates is cancelled and the janitor timer is cleared.
 */
export function startTelegramBot(deps: TelegramBotDeps): TelegramBot {
  const pollTimeoutSec = deps.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
  const bindingTtlMin = deps.bindingTtlMin ?? DEFAULT_BINDING_TTL_MIN;
  const janitorIntervalMs = deps.janitorIntervalMs ?? DEFAULT_JANITOR_INTERVAL_MS;

  let stopped = false;
  let offset = 0;
  // AbortController per loop iteration so SIGTERM can interrupt the
  // hanging long-poll without waiting up to 30s for it to time out.
  let currentAbort: AbortController | null = null;

  // Defensive deleteWebhook: a stray webhook from a past experiment
  // would make getUpdates return 409 forever. Cheap one-shot at boot.
  void fetch(`https://api.telegram.org/bot${deps.botToken}/deleteWebhook`, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => deps.logger.warn({ err }, 'telegram bot: deleteWebhook failed'));

  async function pollOnce(): Promise<void> {
    currentAbort = new AbortController();
    // pollTimeoutSec drives Telegram-side wait; add 5s for the HTTP
    // round-trip so the AbortSignal doesn't fire before the server
    // would have responded naturally.
    const fetchTimeout = setTimeout(() => currentAbort?.abort(), (pollTimeoutSec + 5) * 1000);

    try {
      const params = new URLSearchParams({
        offset: String(offset),
        timeout: String(pollTimeoutSec),
      });
      const res = await fetch(`https://api.telegram.org/bot${deps.botToken}/getUpdates?${params}`, {
        signal: currentAbort.signal,
      });
      const json = (await res.json()) as GetUpdatesResponse;
      if (!json.ok) {
        deps.logger.warn(
          { status: res.status, description: json.description },
          'telegram bot: getUpdates not ok',
        );
        return;
      }
      const updates = json.result ?? [];
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        try {
          const result = await processUpdate(deps.db, update, bindingTtlMin, deps.logger);
          if (result.replyChatId !== undefined && result.replyText !== undefined) {
            await sendReply(deps.botToken, result.replyChatId, result.replyText, deps.logger);
          }
        } catch (err) {
          deps.logger.error(
            { err, updateId: update.update_id },
            'telegram bot: update handler threw',
          );
        }
      }
    } catch (err) {
      // AbortError on stop is expected; everything else gets logged.
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) deps.logger.warn({ err }, 'telegram bot: getUpdates failed');
    } finally {
      clearTimeout(fetchTimeout);
      currentAbort = null;
    }
  }

  // Soft backoff on consecutive failures to avoid hammering Telegram
  // if their API is having a moment. Reset on any successful tick.
  let consecutiveFails = 0;
  const FAIL_BACKOFF_MS = 5_000;

  async function loop(): Promise<void> {
    while (!stopped) {
      const before = Date.now();
      try {
        await pollOnce();
        consecutiveFails = 0;
      } catch (err) {
        consecutiveFails = Math.min(consecutiveFails + 1, 6);
        deps.logger.warn({ err, consecutiveFails }, 'telegram bot: pollOnce loop error');
      }
      // If pollOnce returned in <100ms (e.g. immediate Telegram error),
      // sleep before retrying so a transient outage doesn't spin the
      // event loop. Successful long-polls naturally take ~timeout sec.
      if (Date.now() - before < 100) {
        const wait = Math.min(FAIL_BACKOFF_MS * Math.max(consecutiveFails, 1), 30_000);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  void loop();

  // Periodic janitor — keeps the bindings table small. Skipped on the
  // very first tick (so a freshly-deployed bot doesn't try to delete
  // before any bindings exist), runs every janitorIntervalMs after.
  const janitor = setInterval(() => {
    void pruneExpiredBindings(deps.db, bindingTtlMin)
      .then((n) => {
        if (n > 0) deps.logger.info({ deleted: n }, 'telegram bot: pruned expired bindings');
      })
      .catch((err) => deps.logger.warn({ err }, 'telegram bot: janitor failed'));
  }, janitorIntervalMs);

  deps.logger.info({ pollTimeoutSec, bindingTtlMin }, 'telegram bot: long-poll worker started');

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(janitor);
      currentAbort?.abort();
      // Give the loop one tick to observe `stopped` and bail.
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
