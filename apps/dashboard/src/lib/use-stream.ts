import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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
 * Auth: EventSource cannot send custom headers, so the Privy token is
 * passed as a ?token= query param and validated by requireAuth on the
 * server side.
 */
export function useStream(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!agentId) return;

    let cancelled = false;

    void getAccessToken().then((token) => {
      if (cancelled) return;

      const url = token
        ? `/api/agents/${agentId}/stream?token=${encodeURIComponent(token)}`
        : `/api/agents/${agentId}/stream`;

      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as StreamEvent;
          if (event.type === 'tx.new') {
            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            queryClient.invalidateQueries({ queryKey: ['agent-tx', agentId] });
          } else if (event.type === 'alert.new') {
            queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
            queryClient.invalidateQueries({ queryKey: ['alerts'] });
          }
        } catch {
          // ignore malformed messages
        }
      };

      // Track definitively-closed connections so stale refs don't linger.
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          esRef.current = null;
        }
      };
    });

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [agentId, queryClient]);
}
