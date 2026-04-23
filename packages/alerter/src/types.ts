/**
 * Alerter type definitions (task 5.11 + Epic 14 per-agent routing).
 */

import type { AlertRuleName, AlertSeverity, DeliveryChannel } from '@agentscope/shared';

/**
 * Minimal alert payload the alerter needs to format and deliver.
 *
 * Epic 14 added the per-agent routing hints (`chatId`, `webhookUrl`) so
 * detector-runner/cron can ship one AlertMessage and let the sender pick
 * the destination without extra plumbing. Both are optional — legacy
 * callers that omit them still work (Telegram sender then falls back to
 * its factory-default chatId for demo agents; webhook sender throws at
 * construction time if no URL was bound, so omission is a programming
 * error, not a silent drop).
 */
export interface AlertMessage {
  id: string;
  agentId: string;
  agentName: string;
  ruleName: AlertRuleName;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  triggeredAt: string;
  /** Per-agent Telegram chat_id, if set; else sender falls back to env default. */
  chatId?: string;
  /** Per-agent webhook URL. When present, detector-runner prefers webhook over telegram. */
  webhookUrl?: string;
}

/** Result of a delivery attempt. */
export interface DeliveryResult {
  success: boolean;
  channel: DeliveryChannel;
  error?: string;
}

/** Channel-specific sender interface. */
export interface ChannelSender {
  send: (msg: AlertMessage) => Promise<DeliveryResult>;
}
