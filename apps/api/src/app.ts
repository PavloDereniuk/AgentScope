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
import { Hono } from 'hono';
import type { AuthVerifier } from './lib/auth-verifier';
import type { BusEvent, SseBus } from './lib/sse-bus';
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
  // The ingestion worker POSTs here after persisting a tx or firing an alert.
  // No auth — intended to be called only from within the same Railway project
  // (internal networking). Not exposed externally.
  app.post('/internal/publish', async (c) => {
    const event = (await c.req.json()) as BusEvent;
    deps.sseBus.publish(event);
    return c.json({ ok: true });
  });

  return app;
}
