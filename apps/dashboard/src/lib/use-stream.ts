import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

interface StreamEvent {
  type: 'connected' | 'tx.new' | 'alert.new';
  agentId: string;
  [key: string]: unknown;
}

/**
 * Subscribe to the SSE stream for a specific agent. When a tx.new or
 * alert.new event arrives, the relevant react-query cache is
 * invalidated so the UI refreshes automatically.
 */
export function useStream(agentId: string | undefined) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!agentId) return;

    const es = new EventSource(`/api/agents/${agentId}/stream`);
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

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [agentId, queryClient]);
}
