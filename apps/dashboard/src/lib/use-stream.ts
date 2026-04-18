import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getAccessToken } from './api-client';

interface StreamEvent {
  type: 'connected' | 'tx.new' | 'alert.new';
  agentId: string;
  [key: string]: unknown;
}

/**
 * Subscribe to the SSE stream for a specific agent. When a tx.new or
 * alert.new event arrives, the relevant react-query cache is
 * invalidated so the UI refreshes automatically.
 *
 * Auth: Uses fetch-based streaming so the Privy token is sent via an
 * `Authorization: Bearer` header rather than a URL query param.
 * EventSource was replaced because it cannot set custom headers, which
 * forced the token into the URL where it would appear in access logs,
 * browser history, and HTTP Referer headers.
 *
 * Reconnect: the stream is re-established with exponential backoff (up
 * to 30s) on any non-abort disconnect. The token is re-fetched on each
 * reconnect so an expired Privy JWT is refreshed transparently.
 */
export function useStream(agentId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!agentId) return;

    const controller = new AbortController();
    let backoffMs = 1_000;
    const MAX_BACKOFF = 30_000;

    function handleEvent(event: StreamEvent) {
      if (event.type === 'tx.new') {
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
        queryClient.invalidateQueries({ queryKey: ['agent-tx', agentId] });
      } else if (event.type === 'alert.new') {
        queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
        queryClient.invalidateQueries({ queryKey: ['alerts'] });
      }
    }

    async function runOnce(): Promise<boolean> {
      const token = await getAccessToken();
      if (controller.signal.aborted) return false;

      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (token) headers.Authorization = `Bearer ${token}`;

      let response: Response;
      try {
        response = await fetch(`/api/agents/${agentId}/stream`, {
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return false;
        // eslint-disable-next-line no-console
        console.warn('[useStream] fetch failed, will retry', err);
        return true;
      }

      if (!response.ok || !response.body) {
        // eslint-disable-next-line no-console
        console.warn('[useStream] non-OK response', response.status);
        return true;
      }

      // Reset backoff once the stream opens successfully.
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
              // Don't silently swallow — server-side encoding bugs are easier
              // to catch when at least a console warning surfaces.
              if (import.meta.env.DEV) {
                // eslint-disable-next-line no-console
                console.warn('[useStream] malformed SSE payload', err);
              }
            }
          }
        }
      } catch (err) {
        // AbortError is expected when the component unmounts and the
        // controller.abort() cleanup fires — swallow it silently.
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
        // Exponential backoff with cap.
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(MAX_BACKOFF, backoffMs * 2);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [agentId, queryClient]);
}
