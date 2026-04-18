/**
 * Fire-and-forget HTTP publisher for SSE events (6.15).
 *
 * After persisting a tx or firing an alert, the ingestion worker
 * POSTs a small JSON payload to the API's internal endpoint so the
 * SSE bus can push it to connected dashboards.
 *
 * Bounded concurrency: if the API is slow or down, unconstrained
 * fire-and-forget calls would accumulate pending promises and sockets
 * indefinitely. We cap in-flight requests and drop (with a warn) once
 * the ceiling is reached — SSE is best-effort and clients refetch via
 * REST, so dropping is safer than leaking memory or file descriptors.
 */

import type { Logger } from './logger';

/** Hard ceiling on concurrent outbound publishes. */
const MAX_IN_FLIGHT = 50;

export function createEventPublisher(apiUrl: string, internalSecret: string, logger: Logger) {
  const endpoint = `${apiUrl.replace(/\/$/, '')}/internal/publish`;
  let inFlight = 0;
  let droppedSinceLastLog = 0;

  return (event: { type: string; agentId: string; [key: string]: unknown }) => {
    if (inFlight >= MAX_IN_FLIGHT) {
      droppedSinceLastLog++;
      if (droppedSinceLastLog === 1 || droppedSinceLastLog % 100 === 0) {
        logger.warn(
          { inFlight, dropped: droppedSinceLastLog, eventType: event.type },
          'SSE publish back-pressured — dropping event',
        );
      }
      return;
    }

    inFlight++;
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
      } finally {
        inFlight--;
        droppedSinceLastLog = 0;
      }
    })();
  };
}
