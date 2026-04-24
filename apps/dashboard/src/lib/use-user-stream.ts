import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getAccessToken } from './api-client';
import { resolveApiUrl } from './api-url';

interface StreamEvent {
  type: 'connected' | 'tx.new' | 'alert.new';
  agentId?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Subscribe to the global per-user SSE stream (/api/stream — backed by
 * SseBus.subscribeUser on the server). Replaces the Overview page's
 * 30-second poll on alerts with a push-based flow, and covers tx as
 * well so KPI cards refresh as soon as a new transaction lands for
 * any of the user's agents.
 *
 * Auth: uses fetch-based streaming to keep the Privy token in the
 * Authorization header instead of the URL query string — the same
 * pattern established for per-agent streams in use-stream.ts. We do
 * NOT use EventSource: it cannot set custom headers, and pushing a
 * token into the URL would surface it in access logs, browser
 * history, and Referer headers.
 *
 * Reconnect: exponential backoff up to 30s; the token is refreshed
 * on every reconnect so an expired Privy JWT is transparently
 * renewed.
 */
export function useUserStream(enabled = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let backoffMs = 1_000;
    const MAX_BACKOFF = 30_000;

    function handleEvent(event: StreamEvent) {
      // Push-based invalidations that match the Overview page's query keys.
      // The KPI/ticker cards re-fetch on next render; react-query dedupes
      // across concurrent invalidations so a burst of events costs one
      // network request, not one per event.
      if (event.type === 'tx.new') {
        queryClient.invalidateQueries({ queryKey: ['stats', 'overview'] });
        queryClient.invalidateQueries({ queryKey: ['stats', 'timeseries'] });
        queryClient.invalidateQueries({ queryKey: ['agents'] });
        if (event.agentId) {
          queryClient.invalidateQueries({ queryKey: ['agent', event.agentId] });
          queryClient.invalidateQueries({ queryKey: ['agent-tx', event.agentId] });
        }
      } else if (event.type === 'alert.new') {
        queryClient.invalidateQueries({ queryKey: ['alerts'] });
        queryClient.invalidateQueries({ queryKey: ['stats', 'overview'] });
      }
    }

    async function runOnce(): Promise<boolean> {
      const token = await getAccessToken();
      if (controller.signal.aborted) return false;

      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let response: Response;
      try {
        response = await fetch(resolveApiUrl('/api/stream'), {
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return false;
        // eslint-disable-next-line no-console
        console.warn('[useUserStream] fetch failed, will retry', err);
        return true;
      }

      if (!response.ok || !response.body) {
        // eslint-disable-next-line no-console
        console.warn('[useUserStream] non-OK response', response.status);
        return true;
      }

      backoffMs = 1_000;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || controller.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              handleEvent(JSON.parse(line.slice(6)) as StreamEvent);
            } catch (err) {
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn('[useUserStream] malformed SSE payload', err);
              }
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return false;
        throw err;
      } finally {
        reader.releaseLock();
      }
      return true;
    }

    void (async () => {
      while (!controller.signal.aborted) {
        const shouldRetry = await runOnce();
        if (controller.signal.aborted || !shouldRetry) break;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(MAX_BACKOFF, backoffMs * 2);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [enabled, queryClient]);
}
