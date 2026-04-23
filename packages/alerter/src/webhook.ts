/**
 * Webhook alert sender (task 14.2).
 *
 * Delivers an alert as a POST JSON payload to the agent's webhookUrl.
 * Intended for Discord/Slack incoming webhooks or any user-controlled
 * HTTP endpoint. Pairs with the telegram sender as the second
 * first-class channel — previously the delivery router's default
 * branch returned "channel webhook not supported in MVP" even though
 * `agents.webhookUrl` has been in the schema + UI since Epic 1.
 *
 * Retry policy mirrors telegram.ts:
 *   - 3 attempts total
 *   - 10s per-request timeout via AbortSignal.timeout
 *   - retry on network error and 5xx; give up on 4xx (client error)
 *   - truncate error messages to 200 chars (matches alerts.delivery_error shape)
 */

import type { AlertMessage, DeliveryResult } from './types';

const MAX_RETRIES = 3;
const WEBHOOK_FETCH_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 200;

export interface WebhookConfig {
  /**
   * Destination URL resolved per-message at call time. Stored here only as
   * a factory seam for tests; production callers pass `url` on the message
   * via the sender returned by `createWebhookSender`.
   */
  url: string;
}

/**
 * Fetch implementation used by the sender. Exposed for tests so they
 * can mock globalThis.fetch without monkey-patching the global. Defaults
 * to `globalThis.fetch` which is always present on Node 18+.
 */
export type FetchLike = typeof globalThis.fetch;

function truncateError(msg: string): string {
  return msg.length > MAX_ERROR_CHARS ? msg.slice(0, MAX_ERROR_CHARS) : msg;
}

function shouldRetry(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Create a webhook sender bound to a specific URL. The returned
 * `send(msg)` posts `{alert, agent}` JSON and retries on transient
 * failures. Returns a failed DeliveryResult (never throws) so the
 * caller can record `deliveryStatus: 'failed'` and keep going.
 */
export function createWebhookSender(config: WebhookConfig, fetchImpl?: FetchLike) {
  if (typeof config.url !== 'string' || config.url.trim().length === 0) {
    throw new Error('[alerter] webhook url is required and must be a non-empty string');
  }

  // Validate URL shape up-front so a typo in an agent row surfaces as a
  // startup error, not as silent delivery failures at runtime.
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new Error(`[alerter] webhook url is not a valid URL: ${config.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[alerter] webhook url must use http(s), got ${parsed.protocol}`);
  }

  const doFetch: FetchLike = fetchImpl ?? globalThis.fetch;

  return {
    async send(msg: AlertMessage): Promise<DeliveryResult> {
      const body = JSON.stringify({
        alert: {
          id: msg.id,
          ruleName: msg.ruleName,
          severity: msg.severity,
          payload: msg.payload,
          triggeredAt: msg.triggeredAt,
        },
        agent: {
          id: msg.agentId,
          name: msg.agentName,
        },
      });

      let lastError = 'unknown error';

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const res = await doFetch(config.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(WEBHOOK_FETCH_TIMEOUT_MS),
          });

          if (res.ok) {
            return { success: true, channel: 'webhook' };
          }

          // 4xx errors signal the request is malformed or the endpoint is
          // gone — retrying will not fix them. Only retry on 5xx.
          if (!shouldRetry(res.status)) {
            const text = await res.text().catch(() => '');
            const errMsg = text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status}`;
            return { success: false, channel: 'webhook', error: truncateError(errMsg) };
          }

          lastError = `HTTP ${res.status}`;
          // Fall through to next attempt.
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      return { success: false, channel: 'webhook', error: truncateError(lastError) };
    },
  };
}
