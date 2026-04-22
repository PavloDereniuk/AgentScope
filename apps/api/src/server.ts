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

const config = loadConfig();

const db = createDb({
  connectionString: config.DATABASE_URL,
  // api is read-heavy + reuses connections across requests; keep pool
  // small so ingestion and cron share the Supabase free-tier budget.
  maxConnections: 5,
});

const verifier = createPrivyVerifier(config.PRIVY_APP_ID, config.PRIVY_APP_SECRET);
const sseBus = createSseBus(logger);

// Optional Telegram sender — only wired when creds are present. Used by the
// POST /api/agents/:id/test-alert endpoint (task 13.7). Missing creds →
// route returns `{ok: false, error: '...'}` instead of failing startup.
const alerter: DeliverDeps = {};
if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_DEFAULT_CHAT_ID) {
  alerter.telegram = createTelegramSender({
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_DEFAULT_CHAT_ID,
  });
}

const app = buildApp({
  db,
  verifier,
  sseBus,
  internalSecret: config.INTERNAL_SECRET,
  alerter,
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
