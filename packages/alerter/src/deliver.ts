/**
 * Delivery strategy router (task 5.13).
 *
 * Routes an alert to the appropriate channel sender. Epic 14 added the
 * `webhook` channel as a first-class citizen alongside `telegram`.
 * Discord/Slack channels are stubs — for MVP users set their Discord/Slack
 * incoming-webhook URL as the agent's webhookUrl and route via `webhook`.
 */

import type { DeliveryChannel } from '@agentscope/shared';
import type { AlertMessage, ChannelSender, DeliveryResult } from './types';

export interface DeliverDeps {
  telegram?: ChannelSender;
  webhook?: ChannelSender;
}

/**
 * Deliver an alert through the specified channel. Returns a result
 * indicating success or failure.
 */
export async function deliver(
  deps: DeliverDeps,
  msg: AlertMessage,
  channel: DeliveryChannel,
): Promise<DeliveryResult> {
  switch (channel) {
    case 'telegram': {
      if (!deps.telegram) {
        return { success: false, channel, error: 'telegram sender not configured' };
      }
      return deps.telegram.send(msg);
    }
    case 'webhook': {
      if (!deps.webhook) {
        return { success: false, channel, error: 'webhook sender not configured' };
      }
      return deps.webhook.send(msg);
    }
    default:
      return { success: false, channel, error: `channel ${channel} not supported in MVP` };
  }
}
