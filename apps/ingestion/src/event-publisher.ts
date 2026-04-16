/**
 * Fire-and-forget HTTP publisher for SSE events (6.15).
 *
 * After persisting a tx or firing an alert, the ingestion worker
 * POSTs a small JSON payload to the API's internal endpoint so the
 * SSE bus can push it to connected dashboards.
 */

import type { Logger } from './logger';

export function createEventPublisher(apiUrl: string, internalSecret: string, logger: Logger) {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/internal/publish`;

  return (event: { type: string; agentId: string; [key: string]: unknown }) => {
    void (async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': internalSecret,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          logger.warn({ status: res.status, eventType: event.type }, 'SSE publish returned non-OK');
        }
      } catch (err) {
        logger.warn({ err, eventType: event.type }, 'failed to publish SSE event');
      }
    })();
  };
}
