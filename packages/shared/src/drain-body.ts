/**
 * Discard an HTTP response body we are not going to read.
 *
 * Node's `fetch` (undici) does not free a response body just because the
 * caller ignored it. Until the `Response` is garbage-collected the buffered
 * body stays on the heap and the underlying socket is not returned to the
 * connection pool. On a cold path that is invisible; on a hot one it is a
 * leak that scales with traffic — `event-publisher.ts` fires one request per
 * persisted transaction AND per alert, which is what ratcheted the ingestion
 * worker's RSS by ~200 MB/day between deploys (Railway bill, Aug 2026).
 *
 * We *consume* the body rather than `body.cancel()` it. Cancelling aborts the
 * stream and makes undici destroy the connection; reading it to completion
 * frees the buffer AND leaves the socket reusable. Every response we drain
 * here is a small JSON ack (internal publish endpoint, Telegram API, user
 * webhooks), so reading it costs nothing. Do NOT use this helper on a
 * potentially large body — cancel that one instead.
 *
 * Deliberately tolerant: `bodyUsed` guards against double-drain, the
 * `arrayBuffer` check keeps hand-rolled test doubles working, and any throw
 * is swallowed. A failure to release memory must never turn into a failure to
 * deliver an alert.
 */

/**
 * Structural subset of `Response` — narrow enough that a test double
 * (`{ ok: true, status: 200 }`) satisfies it without modelling a real stream.
 */
export interface DrainableResponse {
  bodyUsed?: boolean;
  arrayBuffer?: () => Promise<unknown>;
}

export async function drainBody(res: DrainableResponse): Promise<void> {
  if (res.bodyUsed === true) return;
  if (typeof res.arrayBuffer !== 'function') return;
  try {
    await res.arrayBuffer();
  } catch {
    // Already consumed, connection reset, or a stub that doesn't implement
    // it — there is nothing left to release in any of those cases.
  }
}
