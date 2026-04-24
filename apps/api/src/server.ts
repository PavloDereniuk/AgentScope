/**
 * HTTP server entrypoint. Loads config, wires real dependencies, and
 * binds the Hono app to a port. Kept separate from `./app.ts` so tests
 * import `buildApp` without triggering env loading or port binding.
 */

import { type DeliverDeps, createTelegramSender } from '@agentscope/alerter';
import { createDb } from '@agentscope/db';
import { serve } from '@hono/node-server';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPrivyVerifier } from './lib/auth-verifier';
import { createSseBus } from './lib/sse-bus';
import { logger } from './logger';
import { createRateLimiter } from './middleware/rate-limit';

const config = loadConfig();

const db = createDb({
  connectionString: config.DATABASE_URL,
  // api is read-heavy + reuses connections across requests; keep pool
  // small so ingestion and cron share the Supabase free-tier budget.
  maxConnections: 5,
});

const verifier = createPrivyVerifier(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET);
const sseBus = createSseBus(logger);

// Optional Telegram sender — only wired when the bot token is present.
// Used by POST /api/agents/:id/test-alert (task 13.7). Per-agent chat_id
// rides on each AlertMessage (Epic 14); the sender has no deployer-wide
// fallback. Missing token → /test-alert returns 503.
const alerter: DeliverDeps = {};
if (config.TELEGRAM_BOT_TOKEN) {
  alerter.telegram = createTelegramSender({ botToken: config.TELEGRAM_BOT_TOKEN });
}

// Production rate limiters (task 14.13). Single-instance assumption — counters
// live in this process's heap. When Railway is scaled out, swap for Redis
// INCR + EXPIRE; until then, each pod has its own budget which is fine for
// MVP scale (one container).
const agentCreateLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60_000 });
const otlpLimiter = createRateLimiter({ limit: 100, windowMs: 60_000 });
// 14.15 — per-IP signup throttle (3 / 24h). Layered in front of the
// per-user limiter so one IP churning through fresh Privy DIDs still
// gets 429'd. Railway proxies expose the client IP via x-forwarded-for;
// local dev without a reverse proxy sees null and skips the check.
const agentCreateIpLimiter = createRateLimiter({ limit: 3, windowMs: 24 * 60 * 60_000 });

// Parse DASHBOARD_ORIGINS once at boot — trim whitespace and drop
// empties so a stray comma in the env var doesn't whitelist `''`
// (which hono/cors would then happily echo back as Access-Control-
// Allow-Origin).
const allowedOrigins = config.DASHBOARD_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

const app = buildApp({
  db,
  verifier,
  sseBus,
  internalSecret: config.INTERNAL_SECRET,
  alerter,
  agentCreateLimiter,
  agentCreateIpLimiter,
  otlpLimiter,
  maxAgentsPerUser: config.MAX_AGENTS_PER_USER,
  ...(config.TELEGRAM_BOT_USERNAME ? { telegramBotUsername: config.TELEGRAM_BOT_USERNAME } : {}),
  ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  logger,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'agentscope-api listening');
});

// Graceful shutdown: Railway and most PaaS send SIGTERM before SIGKILL.
// Close the HTTP server to stop accepting new connections, then drain the
// Postgres pool so in-flight inserts get a chance to flush.
const shutdown = (signal: string) => {
  logger.info({ signal }, 'api shutting down');
  server.close((err) => {
    if (err) logger.error({ err }, 'http server close failed');
    db.$client
      .end({ timeout: 5 })
      .catch((e: unknown) => logger.error({ err: e }, 'db pool drain failed'))
      .finally(() => process.exit(err ? 1 : 0));
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
