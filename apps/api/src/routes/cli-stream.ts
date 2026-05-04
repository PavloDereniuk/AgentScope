/**
 * CLI SSE stream — token-authenticated per-agent live tail for the
 * `agentscope watch` command-line tool.
 *
 * Exposes `GET /v1/agents/:id/stream`, mounted on the same `/v1`
 * surface as OTLP ingest so a single environment pair —
 * `AGENTSCOPE_API_URL` + `AGENTSCOPE_AGENT_TOKEN` — works for both
 * pushing traces and pulling live events. Devs already have these
 * configured for their SDK exporter; the CLI reuses them as-is.
 *
 * Why a separate route from `/api/agents/:id/stream`:
 *   - That route authenticates with a Privy session JWT, which a CLI
 *     would need to acquire via a browser login flow. Overkill for
 *     "tail my agent in the terminal".
 *   - This route accepts the same per-agent ingest token the SDK
 *     uses, which devs already keep in their local `.env`. No new
 *     credential to manage, no `agentscope login` flow.
 *   - Mixing both auth modes on one route blurs the security
 *     boundary between push (ingest_token) and pull (Privy session).
 *     A dedicated route makes the contract explicit.
 *
 * Security notes:
 *   - URL `:id` MUST equal the agent the token resolves to. A token
 *     can never be used to read another agent's stream — even if the
 *     attacker guesses a valid UUID.
 *   - 404 is returned for both "no such agent" and "token does not
 *     match this agent" so the route is not an existence oracle.
 */

import type { Database } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { SseBus } from '../lib/sse-bus';
import type { Logger } from '../logger';
import { resolveAgentByToken } from '../otlp/auth';

const KEEPALIVE_MS = 30_000;
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

const agentIdParamSchema = z.object({
  id: z.string().uuid(),
});

interface CliStreamRouterDeps {
  db: Database;
  sseBus: SseBus;
  logger: Logger;
}

export function createCliStreamRouter({ db, sseBus, logger }: CliStreamRouterDeps) {
  const router = new Hono();

  router.get(
    '/agents/:id/stream',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const { id: agentId } = c.req.valid('param');

      const header = c.req.header('Authorization');
      if (!header) {
        throw new HTTPException(401, { message: 'missing authorization header' });
      }
      const match = BEARER_RE.exec(header);
      if (!match?.[1]) {
        throw new HTTPException(401, { message: 'malformed authorization header' });
      }
      const token = match[1];

      const resolved = await resolveAgentByToken(db, token);
      // Single 404 surface for both unknown token and wrong-agent token —
      // never let the response distinguish "this token is bad" from
      // "this token is good but for a different agent."
      if (!resolved || resolved.agentId !== agentId) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (data: string) => {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            };

            send(JSON.stringify({ type: 'connected' }));

            let unsub: () => void = () => {};
            try {
              unsub = sseBus.subscribe(agentId, (event) => {
                send(JSON.stringify(event));
              });
            } catch (err) {
              logger.error({ err, agentId }, 'cli-stream: subscribe failed');
              try {
                controller.close();
              } catch {
                // already closed
              }
              throw err;
            }

            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
              }
            }, KEEPALIVE_MS);

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
            Vary: 'Authorization',
            Connection: 'keep-alive',
          },
        },
      );
    },
  );

  return router;
}
