/**
 * @agentscope/alerter — alert delivery (5.11-5.13).
 *
 * Exports types, Telegram sender, and the deliver() strategy router.
 */

export type { AlertMessage, ChannelSender, DeliveryResult } from './types';
export { deliver } from './deliver';
export type { DeliverDeps } from './deliver';
export { createTelegramSender, formatTelegramMessage } from './telegram';
export type { TelegramConfig } from './telegram';
