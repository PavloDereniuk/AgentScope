/**
 * Global per-user SSE stream (task 13.13).
 *
 * GET /api/stream
 *
 * Dashboards that need "tell me when anything happens to any of my
 * agents" open this once instead of one stream per agent. The bus
 * routes every published event to both the `agentId` channel and the
 * `userId` channel (see `lib/sse-bus.ts`), so new agents created mid-
 * session are picked up automatically — the next event carrying the
 * user's id reaches the handler without a reconnect.
 *
 * Auth reuses the API-wide `requireAuth` middleware: the token in the
 * Authorization header gates the open, and the resolved `userId` is
 * used to pick the per-user channel. The dashboard uses fetch-stream
 * (see `apps/dashboard/src/lib/use-user-stream.ts`) to keep the token
 * in the header rather than a URL query string — same pattern
 * established for /api/agents/:id/stream under auth-hygiene work in
 * Epic 14.
 */

import type { Database } from '@agentscope/db';
import { Hono } from 'hono';
import type { SseBus } from '../lib/sse-bus';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const KEEPALIVE_MS = 30_000;

export function createStreamRouter(db: Database, sseBus: SseBus) {
  const router = new Hono<ApiEnv>();

  router.get('/', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (data: string) => {
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          };

          // Initial handshake so the client can tell the difference
          // between "connected but silent" and "hung somewhere in between".
          send(JSON.stringify({ type: 'connected' }));

          let unsub: () => void = () => {};
          try {
            unsub = sseBus.subscribeUser(user.id, (event) => {
              send(JSON.stringify(event));
            });
          } catch (err) {
            try {
              controller.close();
            } catch {
              // already closed
            }
            throw err;
          }

          // Keepalive every 30s to prevent proxy/LB timeouts. SSE
          // comments (`:` lines) are ignored by the browser but keep
          // the underlying TCP connection warm.
          const keepalive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            } catch {
              clearInterval(keepalive);
            }
          }, KEEPALIVE_MS);

          // Cleanup when the client disconnects — close the stream
          // to free the bus subscription and the interval timer.
          c.req.raw.signal.addEventListener('abort', () => {
            unsub();
            clearInterval(keepalive);
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      },
    );
  });

  return router;
}
