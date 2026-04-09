/**
 * Delivery strategy router (task 5.13).
 *
 * Routes an alert to the appropriate channel sender. For MVP only
 * Telegram is supported; Discord/Slack stubs return failure.
 */

import type { DeliveryChannel } from '@agentscope/shared';
import type { AlertMessage, ChannelSender, DeliveryResult } from './types';

export interface DeliverDeps {
  telegram?: ChannelSender;
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
    default:
      return { success: false, channel, error: `channel ${channel} not supported in MVP` };
  }
}
