import { getAccessToken } from '@/lib/api-client';
import { useEffect, useState } from 'react';

export type SseStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Track a lightweight SSE heartbeat against the global connectivity endpoint.
 *
 * The dashboard already opens per-agent streams via `useStream`, but the TopBar
 * needs a single app-wide signal that "the pipe is healthy." We ping
 * `/api/health` (authenticated) with credentials each interval and flip to
 * `reconnecting` after a failure. The path must sit under `/api/*` so the
 * Vite dev proxy forwards to the real backend — pinging `/health` directly
 * returns `index.html` and would read as a false positive.
 */
export function useSseStatus(): SseStatus {
  const [status, setStatus] = useState<SseStatus>('connecting');

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      try {
        const token = await getAccessToken();
        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch('/api/health', {
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        if (cancelled) return;
        setStatus(res.ok ? 'connected' : 'reconnecting');
      } catch {
        if (!cancelled) setStatus('reconnecting');
      }
    }

    void ping();
    const handle = window.setInterval(ping, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  return status;
}
