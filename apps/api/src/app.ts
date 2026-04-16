/**
 * Hono app factory — wires every dependency into a single Hono<ApiEnv>
 * instance and returns it. Tests build the app with stub dependencies
 * (fake verifier, PGlite database, silent logger); `server.ts` builds it
 * with real dependencies loaded from environment at process start.
 *
 * This is the composition root. No module-level DB/Privy/bus singletons
 * live anywhere else in the codebase — if a test or a tool wants a
 * different flavor of the app, it creates one via `buildApp`.
 */

import type { Database } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthVerifier } from './lib/auth-verifier';
import { type SseBus, busEventSchema } from './lib/sse-bus';
import { type Logger, logger as defaultLogger } from './logger';
import { type ApiEnv, requireAuth } from './middleware/auth';
import { registerErrorHandlers } from './middleware/error';
import { createAgentsRouter } from './routes/agents';
import { createAlertsRouter } from './routes/alerts';
import { createOtlpRouter } from './routes/otlp';
import { createTransactionsRouter } from './routes/transactions';

export interface AppDeps {
  db: Database;
  verifier: AuthVerifier;
  sseBus: SseBus;
  /**
   * Shared secret validated on /internal/* endpoints.
   * Required in production (enforced via config.ts INTERNAL_SECRET).
   * Tests may omit it — the endpoint will reject all requests in that case.
   */
  internalSecret?: string;
  logger?: Logger;
}

export function buildApp(deps: AppDeps) {
  const log = deps.logger ?? defaultLogger;
  const app = new Hono<ApiEnv>();

  registerErrorHandlers(app, log);

  // Public: liveness check for Railway, uptime pings, etc.
  app.get('/health', (c) => c.json({ ok: true }));

  // OTLP/HTTP ingest lives at /v1/traces — the canonical path every
  // OpenTelemetry SDK exporter hits by default. Not mounted under
  // /api because it uses its own agent-token auth (task 4.3):
  // the agent's OTel Resource must carry an `agent.token` attribute
  // whose value matches `agents.ingest_token`.
  app.route('/v1', createOtlpRouter({ logger: log, db: deps.db }));

  // Every /api/* route is authenticated. The auth middleware populates
  // `c.var.userId` so downstream routes can resolve the real users.id
  // via `ensureUser` without touching headers directly.
  const api = new Hono<ApiEnv>();
  api.use('*', requireAuth(deps.verifier, log));
  api.route('/agents', createAgentsRouter(deps.db, deps.sseBus));
  api.route('/transactions', createTransactionsRouter(deps.db));
  api.route('/alerts', createAlertsRouter(deps.db));

  app.route('/api', api);

  // Internal endpoint for cross-service event publishing (6.15).
  // Protected by a shared secret — the ingestion worker must send
  // X-Internal-Secret matching INTERNAL_SECRET env var.
  app.post(
    '/internal/publish',
    zValidator('json', busEventSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid event payload' });
      }
    }),
    async (c) => {
      const secret = c.req.header('X-Internal-Secret');
      if (!deps.internalSecret || !secret || secret !== deps.internalSecret) {
        throw new HTTPException(401, { message: 'unauthorized' });
      }
      deps.sseBus.publish(c.req.valid('json'));
      return c.json({ ok: true });
    },
  );

  return app;
}
