/**
 * Fire-and-forget HTTP publisher for SSE events (6.15).
 *
 * After persisting a tx or firing an alert, the ingestion worker
 * POSTs a small JSON payload to the API's internal endpoint so the
 * SSE bus can push it to connected dashboards.
 */

import type { Logger } from './logger';

export function createEventPublisher(apiUrl: string, logger: Logger) {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/internal/publish`;

  return (event: { type: string; agentId: string; [key: string]: unknown }) => {
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }).catch((err) => {
      logger.warn({ err, eventType: event.type }, 'failed to publish SSE event');
    });
  };
}
