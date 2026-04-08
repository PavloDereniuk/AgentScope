/**
 * AgentScope API entrypoint.
 *
 * Responsibilities (built up across tasks 3.1 → 5.x):
 *   3.1 — Hono skeleton with /health
 *   3.2 — global error middleware
 *   3.3 — Privy JWT auth middleware
 *   3.4 — in-memory SSE bus
 *   3.5 → 3.9 — agents CRUD routes
 *   3.10 → 3.12 — transactions + alerts read routes
 *   4.x — OTLP receiver for reasoning logs
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  // biome-ignore lint/suspicious/noConsoleLog: startup banner — pino logger lands in 3.2.
  console.log(`agentscope-api listening on http://localhost:${info.port}`);
});

export { app };
