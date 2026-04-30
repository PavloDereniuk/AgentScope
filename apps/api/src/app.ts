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
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { AuthVerifier } from './lib/auth-verifier';
import { type SseBus, busEventSchema } from './lib/sse-bus';
import { type Logger, logger as defaultLogger } from './logger';
import { type ApiEnv, requireAuth } from './middleware/auth';
import { registerErrorHandlers } from './middleware/error';
import type { RateLimiter } from './middleware/rate-limit';
import { createAgentsRouter } from './routes/agents';
import { createAlertsRouter } from './routes/alerts';
import { createIngestRouter } from './routes/ingest';
import { createOtlpRouter } from './routes/otlp';
import { createReasoningRouter } from './routes/reasoning';
import { createSearchRouter } from './routes/search';
import { createStatsRouter } from './routes/stats';
import { createStreamRouter } from './routes/stream';
import { createTelegramRouter } from './routes/telegram';
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
  /**
   * Telegram bot username (no leading @). Used to build the t.me deep link
   * returned by POST /api/telegram/init. Falls back to TELEGRAM_BOT_USERNAME
   * env var inside the router. When neither is set, /init returns 503.
   */
  telegramBotUsername?: string;
  /**
   * Override for the agent-create rate limiter (10/hour/userId by default).
   * Tests pass a high-limit limiter — or omit and accept the default —
   * to avoid 429ing batch fixture seeders.
   */
  agentCreateLimiter?: RateLimiter;
  /**
   * Override for the OTLP /v1/traces rate limiter (100/min/agent.token).
   * Same pattern as agentCreateLimiter.
   */
  otlpLimiter?: RateLimiter;
  /**
   * Hard cap on agents a single user can own. Defaults to
   * `Number.POSITIVE_INFINITY` when omitted — tests create many agents
   * per user without opting into the production cap. `server.ts` loads
   * the real value from `MAX_AGENTS_PER_USER` (default 2).
   */
  maxAgentsPerUser?: number;
  /**
   * Per-IP rate limiter for POST /api/agents (Epic 14 Phase 3 — abuse
   * hardening). Layered in *front* of `agentCreateLimiter` so a flood
   * of fresh Privy signups from one IP gets 429'd before it consumes
   * the per-user budget. Extracted from `x-forwarded-for` (Railway) or
   * `cf-connecting-ip` (Cloudflare); requests that expose neither
   * header are not rate-limited by IP — the per-user cap still applies.
   */
  agentCreateIpLimiter?: RateLimiter;
  /**
   * Browser origins permitted to call the API cross-origin. When the
   * list is empty (local dev, tests) the CORS middleware is not
   * mounted at all, so same-origin callers see no extra headers and no
   * OPTIONS handshake. Production composition root (`server.ts`) reads
   * this from `DASHBOARD_ORIGINS` env var.
   */
  allowedOrigins?: string[];
  logger?: Logger;
}

export function buildApp(deps: AppDeps) {
  const log = deps.logger ?? defaultLogger;
  const app = new Hono<ApiEnv>();

  registerErrorHandlers(app, log);

  // CORS is only mounted when at least one origin is whitelisted. This
  // keeps local dev and the test suite entirely same-origin (no extra
  // headers, no preflight round-trips). Production wires the Vercel
  // dashboard domain(s) via DASHBOARD_ORIGINS. We whitelist
  // `Authorization` + `Content-Type` because the Privy JWT rides on
  // every request and several routes (POST/PATCH) send JSON bodies;
  // credentials stay disabled — we use Bearer tokens, never cookies.
  const allowedOrigins = deps.allowedOrigins ?? [];
  if (allowedOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: allowedOrigins,
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: 600,
        credentials: false,
      }),
    );
  }

  // Per-budget limiters are wired explicitly by the production composition
  // root (`server.ts`) so tests can opt out by simply not passing them.
  // The dedicated `tests/rate-limit.test.ts` proves the limiter math; the
  // 200+ functional tests would otherwise have to thread a high-limit
  // override through every `buildApp` call to avoid 429s while seeding
  // fixtures.
  const agentCreateLimiter = deps.agentCreateLimiter;
  const agentCreateIpLimiter = deps.agentCreateIpLimiter;
  const otlpLimiter = deps.otlpLimiter;

  // Public: liveness check for Railway, uptime pings, etc.
  app.get('/health', (c) => c.json({ ok: true }));

  // OTLP/HTTP ingest lives at /v1/traces — the canonical path every
  // OpenTelemetry SDK exporter hits by default. Not mounted under
  // /api because it uses its own agent-token auth (task 4.3):
  // the agent's OTel Resource must carry an `agent.token` attribute
  // whose value matches `agents.ingest_token`.
  app.route(
    '/v1',
    createOtlpRouter({
      logger: log,
      db: deps.db,
      ...(otlpLimiter ? { rateLimit: otlpLimiter } : {}),
    }),
  );

  // L0 ingest: flat-JSON `POST /v1/spans` for non-Node agents and
  // demos that prefer a single curl call over wiring an OTel SDK.
  // Mounted alongside `/v1/traces` and shares the same per-token rate
  // limiter so an agent cannot bypass the OTLP budget by switching
  // surfaces. Auth uses standard `Authorization: Bearer ...` instead
  // of the OTel resource-attribute idiom — see routes/ingest.ts for
  // the rationale.
  app.route(
    '/v1',
    createIngestRouter({
      db: deps.db,
      logger: log,
      ...(otlpLimiter ? { rateLimit: otlpLimiter } : {}),
    }),
  );

  // Every /api/* route is authenticated. The auth middleware populates
  // `c.var.userId` so downstream routes can resolve the real users.id
  // via `ensureUser` without touching headers directly.
  const api = new Hono<ApiEnv>();
  // Block CDN / intermediary caching of authenticated responses. Railway
  // fronts this service with a Fastly edge; without an explicit directive
  // it happily reused a cached 200 body across users once a single
  // authenticated GET landed. `private, no-store` keeps responses in the
  // user's own browser only, and `Vary: Authorization` hardens the cache
  // key against token-mixing if some intermediary ignores `no-store`.
  //
  // Mounted *before* `requireAuth` so the headers ride along on 401
  // rejections too — an unauth'd 401 cached by a CDN would prevent the
  // real 200 from ever reaching a dashboard that subsequently authed.
  // Handlers that need different semantics (SSE streams set their own
  // `Cache-Control: no-cache`) override by calling `c.header()` later.
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Authorization');
    await next();
  });
  api.use('*', requireAuth(deps.verifier, log));
  // Authenticated heartbeat for the dashboard's live-pill. Cheaper than
  // GET /api/agents and confirms end-to-end pipe + valid token — the
  // anonymous /health above only tells us the process is up.
  api.get('/health', (c) => c.json({ ok: true }));
  api.route(
    '/agents',
    createAgentsRouter(deps.db, deps.sseBus, deps.alerter, agentCreateLimiter, {
      ...(deps.maxAgentsPerUser !== undefined ? { maxAgentsPerUser: deps.maxAgentsPerUser } : {}),
      ...(agentCreateIpLimiter ? { ipLimiter: agentCreateIpLimiter } : {}),
    }),
  );
  api.route('/transactions', createTransactionsRouter(deps.db));
  api.route('/alerts', createAlertsRouter(deps.db));
  api.route('/stats', createStatsRouter(deps.db));
  api.route('/reasoning', createReasoningRouter(deps.db));
  api.route('/search', createSearchRouter(deps.db));
  api.route('/stream', createStreamRouter(deps.db, deps.sseBus));
  api.route(
    '/telegram',
    createTelegramRouter(deps.db, {
      ...(deps.telegramBotUsername ? { botUsername: deps.telegramBotUsername } : {}),
    }),
  );

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
