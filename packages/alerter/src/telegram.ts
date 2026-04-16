/**
 * Telegram alert sender (task 5.12).
 *
 * Formats an AlertMessage into a Telegram-friendly text and sends it
 * via the Bot API. Uses native fetch (Node 18+).
 */

import type { AlertSeverity } from '@agentscope/shared';
import type { AlertMessage, DeliveryResult } from './types';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
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

/** Format an alert into a human-readable Telegram message. */
export function formatTelegramMessage(msg: AlertMessage): string {
  const icon = SEVERITY_ICON[msg.severity] ?? '📢';
  const lines = [
    `${icon} <b>${escHtml(msg.ruleName.replace(/_/g, ' ').toUpperCase())}</b>`,
    `Agent: <code>${escHtml(msg.agentName)}</code>`,
    `Severity: ${escHtml(msg.severity)}`,
    '',
  ];

  // Add key payload fields — all values are HTML-escaped to prevent injection.
  for (const [key, value] of Object.entries(msg.payload)) {
    if (key === 'signature') {
      lines.push(`Tx: <code>${escHtml(String(value).slice(0, 20))}...</code>`);
    } else {
      lines.push(`${escHtml(key)}: <b>${escHtml(String(value))}</b>`);
    }
  }

  lines.push('', `<i>${escHtml(msg.triggeredAt)}</i>`);
  return lines.join('\n');
}

const MAX_RETRIES = 3;
/** Cap how long we honour Telegram's retry_after to avoid blocking indefinitely. */
const MAX_RETRY_AFTER_SEC = 60;

/**
 * Create a Telegram sender. The returned `send` function posts to the
 * Bot API's sendMessage endpoint with HTML parse mode. Retries up to
 * MAX_RETRIES times on transient failures, honouring Telegram's
 * retry_after field on 429 responses.
 */
export function createTelegramSender(config: TelegramConfig) {
  // URL is built inside `send` — storing it as a constant would embed the
  // bot token in error messages and stack traces emitted by `fetch`.
  const apiBase = 'https://api.telegram.org/bot';

  return {
    async send(msg: AlertMessage): Promise<DeliveryResult> {
      const text = formatTelegramMessage(msg);
      // Build the URL per call so the token never leaks into a stored value.
      const url = `${apiBase}${config.botToken}/sendMessage`;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.chatId,
              text,
              parse_mode: 'HTML',
            }),
          });

          if (res.status === 429) {
            const body = (await res.json().catch(() => null)) as {
              parameters?: { retry_after?: number };
            } | null;
            const waitSec = Math.min(body?.parameters?.retry_after ?? 5, MAX_RETRY_AFTER_SEC);
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            // Increment attempt so 429s count toward MAX_RETRIES and the loop
            // cannot spin forever when Telegram throttles all requests.
            attempt++;
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
