/**
 * HTTP server lifecycle — binds the Hono app to a port.
 * Kept separate from ./index.ts so tests can import `app` without
 * triggering a port bind.
 */

import { serve } from '@hono/node-server';
import { app } from './index';
import { logger } from './logger';

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, 'agentscope-api listening');
});
