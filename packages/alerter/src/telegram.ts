/**
 * Telegram alert sender (task 5.12).
 *
 * Formats an AlertMessage into a Telegram-friendly text and sends it
 * via the Bot API. Uses native fetch (Node 18+).
 */

import type { AlertMessage, DeliveryResult } from './types';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Severity → emoji for visual distinction in Telegram. */
const SEVERITY_ICON: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/** Format an alert into a human-readable Telegram message. */
export function formatTelegramMessage(msg: AlertMessage): string {
  const icon = SEVERITY_ICON[msg.severity] ?? '📢';
  const lines = [
    `${icon} <b>${msg.ruleName.replace(/_/g, ' ').toUpperCase()}</b>`,
    `Agent: <code>${msg.agentName}</code>`,
    `Severity: ${msg.severity}`,
    '',
  ];

  // Add key payload fields
  for (const [key, value] of Object.entries(msg.payload)) {
    if (key === 'signature') {
      lines.push(`Tx: <code>${String(value).slice(0, 20)}...</code>`);
    } else {
      lines.push(`${key}: <b>${String(value)}</b>`);
    }
  }

  lines.push('', `<i>${msg.triggeredAt}</i>`);
  return lines.join('\n');
}

/**
 * Create a Telegram sender. The returned `send` function posts to the
 * Bot API's sendMessage endpoint with HTML parse mode.
 */
export function createTelegramSender(config: TelegramConfig) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  return {
    async send(msg: AlertMessage): Promise<DeliveryResult> {
      try {
        const text = formatTelegramMessage(msg);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text,
            parse_mode: 'HTML',
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { success: false, channel: 'telegram', error: `HTTP ${res.status}: ${body}` };
        }

        return { success: true, channel: 'telegram' };
      } catch (err) {
        return {
          success: false,
          channel: 'telegram',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
