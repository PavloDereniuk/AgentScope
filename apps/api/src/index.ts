/**
 * AgentScope API — Hono app definition.
 *
 * Responsibilities (built up across tasks 3.1 → 5.x):
 *   3.1 — Hono skeleton with /health
 *   3.2 — global error middleware + pino logger
 *   3.3 — Privy JWT auth middleware
 *   3.4 — in-memory SSE bus
 *   3.5 → 3.9 — agents CRUD routes
 *   3.10 → 3.12 — transactions + alerts read routes
 *   4.x — OTLP receiver for reasoning logs
 *
 * This module exports the configured `app` with no side effects, so tests
 * can import and drive it via `app.request(...)`. The server lifecycle
 * lives in ./server.ts.
 */

import { Hono } from 'hono';
import { logger } from './logger';
import { registerErrorHandlers } from './middleware/error';

export const app = new Hono();

registerErrorHandlers(app, logger);

app.get('/health', (c) => c.json({ ok: true }));
