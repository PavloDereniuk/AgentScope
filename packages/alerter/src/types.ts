/**
 * Alerter type definitions (task 5.11).
 */

import type { AlertRuleName, AlertSeverity, DeliveryChannel } from '@agentscope/shared';

/** Minimal alert payload the alerter needs to format and deliver. */
export interface AlertMessage {
  id: string;
  agentId: string;
  agentName: string;
  ruleName: AlertRuleName;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  triggeredAt: string;
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
