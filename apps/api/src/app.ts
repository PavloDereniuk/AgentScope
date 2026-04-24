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

import { timingSafeEqual } from 'node:crypto';
import type { DeliverDeps } from '@agentscope/alerter';
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
import { createReasoningRouter } from './routes/reasoning';
import { createSearchRouter } from './routes/search';
import { createStatsRouter } from './routes/stats';
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
  /**
   * Optional delivery channels for POST /api/agents/:id/test-alert (13.7).
   * When undefined, the endpoint returns `{ok: false, error: 'telegram sender
   * not configured'}` so environments without Telegram creds stay bootable.
   */
  alerter?: DeliverDeps;
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
  // Authenticated heartbeat for the dashboard's live-pill. Cheaper than
  // GET /api/agents and confirms end-to-end pipe + valid token — the
  // anonymous /health above only tells us the process is up.
  api.get('/health', (c) => c.json({ ok: true }));
  api.route('/agents', createAgentsRouter(deps.db, deps.sseBus, deps.alerter));
  api.route('/transactions', createTransactionsRouter(deps.db));
  api.route('/alerts', createAlertsRouter(deps.db));
  api.route('/stats', createStatsRouter(deps.db));
  api.route('/reasoning', createReasoningRouter(deps.db));
  api.route('/search', createSearchRouter(deps.db));

  app.route('/api', api);

  // Internal endpoint for cross-service event publishing (6.15).
  // Protected by a shared secret — the ingestion worker must send
  // X-Internal-Secret matching INTERNAL_SECRET env var.
  //
  // Rate limit: token bucket keyed by agentId. The secret is shared
  // among trusted publishers but if it ever leaks, or a local
  // ingestion bug spins, this caps the blast radius to ~50 events/s
  // per agent — still plenty for real tx volume (Solana peaks ~5 tps/agent).
  const BUCKET_CAPACITY = 50;
  const BUCKET_REFILL_PER_SEC = 50;
  type Bucket = { tokens: number; last: number };
  const buckets = new Map<string, Bucket>();
  const BUCKETS_MAX = 10_000;

  function take(agentId: string): boolean {
    const now = Date.now();
    let b = buckets.get(agentId);
    if (!b) {
      // Loop the eviction so a burst of unique agentIds can't temporarily
      // push `buckets.size` past BUCKETS_MAX. Map iteration order = insertion
      // order, so `.keys().next().value` is the oldest inserted entry.
      while (buckets.size >= BUCKETS_MAX) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      b = { tokens: BUCKET_CAPACITY, last: now };
      buckets.set(agentId, b);
    }
    const elapsedSec = (now - b.last) / 1000;
    b.tokens = Math.min(BUCKET_CAPACITY, b.tokens + elapsedSec * BUCKET_REFILL_PER_SEC);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  app.post(
    '/internal/publish',
    zValidator('json', busEventSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid event payload' });
      }
    }),
    async (c) => {
      const secret = c.req.header('X-Internal-Secret');
      const expected = deps.internalSecret;
      if (!expected || !secret) {
        throw new HTTPException(401, { message: 'unauthorized' });
      }
      // Timing-safe comparison prevents secret enumeration via response-time differences.
      const secretBuf = Buffer.from(secret);
      const expectedBuf = Buffer.from(expected);
      if (secretBuf.length !== expectedBuf.length || !timingSafeEqual(secretBuf, expectedBuf)) {
        throw new HTTPException(401, { message: 'unauthorized' });
      }
      const event = c.req.valid('json');
      if (!take(event.agentId)) {
        throw new HTTPException(429, { message: 'rate limited' });
      }
      deps.sseBus.publish(event);
      return c.json({ ok: true });
    },
  );

  return app;
}
