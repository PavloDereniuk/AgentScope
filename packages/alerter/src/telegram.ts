/**
 * Telegram alert sender (task 5.12).
 *
 * Formats an AlertMessage into a Telegram-friendly text and sends it
 * via the Bot API. Uses native fetch (Node 18+).
 */

import type { AlertSeverity } from '@agentscope/shared';
import {
  formatAlertAction,
  formatAlertDetails,
  formatAlertImpact,
  formatAlertSummary,
  formatRuleTitle,
  isOnChainSignature,
} from '@agentscope/shared';
import type { AlertMessage, DeliveryResult } from './types';

export interface TelegramConfig {
  botToken: string;
}

/** Severity → emoji for visual distinction in Telegram. */
const SEVERITY_ICON: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/** Escape special HTML characters to prevent injection in Telegram HTML mode. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render triggeredAt as "YYYY-MM-DD HH:mm UTC" — stable, locale-independent. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

/**
 * Render a friendly "X ago" prefix so a non-technical owner can grasp recency
 * without doing UTC math. Returns an empty string for unparseable input or
 * future timestamps (clock skew between detector and recipient) — the caller
 * always appends the absolute UTC timestamp anyway.
 */
function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 0) return '';
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec} sec ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return min === 1 ? '1 min ago' : `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours === 1 ? '1h ago' : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1d ago' : `${days}d ago`;
}

/** Capitalize the first character so severity reads as "Warning" not "warning". */
function titleCaseSeverity(s: AlertSeverity): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format an alert into a human-readable Telegram message. */
export function formatTelegramMessage(msg: AlertMessage): string {
  const icon = SEVERITY_ICON[msg.severity] ?? '📢';
  const title = formatRuleTitle(msg.ruleName);
  const summary = formatAlertSummary(msg.ruleName, msg.payload);
  const impact = formatAlertImpact(msg.ruleName, msg.payload);
  const details = formatAlertDetails(msg.ruleName, msg.payload);
  const actions = formatAlertAction(msg.ruleName, msg.payload);

  const lines = [
    `${icon} <b>${escHtml(title)}</b> · ${escHtml(titleCaseSeverity(msg.severity))}`,
    `Agent: <code>${escHtml(msg.agentName)}</code>`,
    '',
    escHtml(summary),
    '',
    `💡 <b>What this means:</b> ${escHtml(impact)}`,
    '',
  ];

  for (const row of details) {
    lines.push(`• ${escHtml(row.label)}: <b>${escHtml(row.value)}</b>`);
  }

  const sig = msg.payload.signature;
  if (typeof sig === 'string' && sig.length > 0) {
    if (isOnChainSignature(sig)) {
      const url = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
      lines.push(`• Tx: <a href="${escHtml(url)}">${escHtml(sig.slice(0, 16))}...</a>`);
    } else {
      lines.push(
        `• Tx: <code>${escHtml(sig.slice(0, 16))}...</code> (test alert — no real transaction)`,
      );
    }
  }

  if (actions.length > 0) {
    lines.push('', '🔧 <b>Suggested actions:</b>');
    for (const action of actions) {
      lines.push(`• ${escHtml(action)}`);
    }
  }

  const relative = formatRelativeTime(msg.triggeredAt);
  const absolute = formatTimestamp(msg.triggeredAt);
  const stamp = relative ? `${relative} · ${absolute}` : absolute;
  lines.push('', `<i>${escHtml(stamp)}</i>`);
  return truncateForTelegram(lines.join('\n'));
}

/**
 * Telegram's sendMessage rejects any `text` longer than 4096 UTF-16 code
 * units with HTTP 400. We keep a small safety margin so the trailing
 * truncation marker itself does not push us over. Alerts should almost
 * always fit; this guards against long `drawdown`/`error_rate` payloads
 * with many `default`-branch detail rows and prevents an entire alert
 * from being dropped.
 */
const TELEGRAM_MAX_CHARS = 4096;
const TELEGRAM_SAFE_CHARS = 4000;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  const marker = '\n…[truncated]';
  return text.slice(0, TELEGRAM_SAFE_CHARS - marker.length) + marker;
}

const MAX_RETRIES = 3;
/** Cap how long we honour Telegram's retry_after to avoid blocking indefinitely. */
const MAX_RETRY_AFTER_SEC = 60;
/** Per-request timeout — Telegram normally responds in <1s; 10s covers slow networks. */
const TELEGRAM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Create a Telegram sender. The returned `send` function posts to the
 * Bot API's sendMessage endpoint with HTML parse mode. Retries up to
 * MAX_RETRIES times on transient failures, honouring Telegram's
 * retry_after field on 429 responses.
 */
export function createTelegramSender(config: TelegramConfig) {
  // Fail fast on empty/whitespace credentials. Otherwise the first alert
  // would retry MAX_RETRIES times against an obviously-invalid bot URL,
  // wasting latency and producing confusing logs on every alert.
  if (typeof config.botToken !== 'string' || config.botToken.trim().length === 0) {
    throw new Error('[alerter] botToken is required and must be a non-empty string');
  }
  // URL is built inside `send` — storing it as a constant would embed the
  // bot token in error messages and stack traces emitted by `fetch`.
  const apiBase = 'https://api.telegram.org/bot';

  return {
    async send(msg: AlertMessage): Promise<DeliveryResult> {
      // Multi-tenant safety (Epic 14 follow-up): the sender no longer
      // falls back to a deployer-wide default chat_id. Every AlertMessage
      // MUST carry its own `chatId` — otherwise we'd silently re-route a
      // new user's alerts to the platform owner's chat. Demo agents set
      // this field via `agents.telegram_chat_id` in the database, not via
      // an env var.
      if (typeof msg.chatId !== 'string' || msg.chatId.trim().length === 0) {
        return {
          success: false,
          channel: 'telegram',
          error: 'no telegram chat_id set for agent',
        };
      }
      const chatId = msg.chatId;
      const text = formatTelegramMessage(msg);
      // Build the URL per call so the token never leaks into a stored value.
      const url = `${apiBase}${config.botToken}/sendMessage`;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'HTML',
            }),
            // Bound individual calls so a hung Telegram connection cannot
            // pin this send() — the detector-runner delivers via Promise.all,
            // so one stuck send would delay every other delivery too.
            signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS),
          });

          if (res.status === 429) {
            const body = (await res.json().catch(() => null)) as {
              parameters?: { retry_after?: number };
            } | null;
            const waitSec = Math.min(body?.parameters?.retry_after ?? 5, MAX_RETRY_AFTER_SEC);
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            // The for-loop's post-increment runs on `continue`, so 429s
            // already count toward MAX_RETRIES — don't increment manually
            // (that would double-advance the counter and halve the retry
            // budget on sustained throttling).
            continue;
          }

          if (!res.ok) {
            let errMsg: string;
            try {
              const json = (await res.json()) as { description?: string };
              errMsg = json.description ?? `HTTP ${res.status}`;
            } catch {
              errMsg = `HTTP ${res.status}`;
            }
            return { success: false, channel: 'telegram', error: errMsg.slice(0, 200) };
          }

          return { success: true, channel: 'telegram' };
        } catch (err) {
          if (attempt < MAX_RETRIES - 1) continue;
          return {
            success: false,
            channel: 'telegram',
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return { success: false, channel: 'telegram', error: 'max retries exceeded' };
    },
  };
}
