/**
 * HTTP server entrypoint. Loads config, wires real dependencies, and
 * binds the Hono app to a port. Kept separate from `./app.ts` so tests
 * import `buildApp` without triggering env loading or port binding.
 */

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
const app = buildApp({ db, verifier, sseBus, logger });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, 'agentscope-api listening');
});
