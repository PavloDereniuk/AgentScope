import { getAccessToken } from '@/lib/api-client';
import { resolveApiUrl } from '@/lib/api-url';
import { useEffect, useState } from 'react';

export type SseStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * Track a lightweight SSE heartbeat against the global connectivity endpoint.
 *
 * The dashboard already opens per-agent streams via `useStream`, but the TopBar
 * needs a single app-wide signal that "the pipe is healthy." We ping
 * `/api/health` (authenticated) each interval and flip to `reconnecting`
 * after a failure. The URL is resolved through `resolveApiUrl` so it
 * matches the rest of the API surface: relative in dev (Vite proxy),
 * absolute to Railway in prod (CORS-whitelisted).
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
        const res = await fetch(resolveApiUrl('/api/health'), {
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
