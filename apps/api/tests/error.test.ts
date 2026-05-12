/**
 * Unit tests for the global error middleware (task 3.2).
 *
 * Covers:
 *   - `/health` still works inside the full `buildApp()` pipeline
 *   - Unhandled throw → 500 with { error: { code: 'INTERNAL_ERROR', … } }
 *   - HTTPException → maps status to code + preserves message
 *   - Unknown route → 404 from notFound handler
 *   - Error details never leak from unhandled throws
 */

import type { Database } from '@agentscope/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { registerErrorHandlers } from '../src/middleware/error';

// Silent logger so test output stays clean.
const silentLogger = pino({ level: 'silent' });

/**
 * Build a real app via `buildApp()` using stub dependencies. The /health
 * and notFound tests only hit routes that never reach db/verifier, so
 * cheap stubs are safe here — full integration lives in agents.test.ts.
 */
function makeRealApp() {
  const stubDb = {} as unknown as Database;
  const stubVerifier: AuthVerifier = {
    async verify() {
      return { userId: 'stub' };
    },
  };
  return buildApp({
    db: stubDb,
    verifier: stubVerifier,
    sseBus: createSseBus(),
    logger: silentLogger,
  });
}

/**
 * Standalone app with just the error handlers + a handful of routes
 * that throw in different ways. Used for the throw/HTTPException cases.
 */
function makeThrowingApp() {
  const app = new Hono();
  registerErrorHandlers(app, silentLogger);
  app.get('/boom', () => {
    throw new Error('top secret internal details');
  });
  app.get('/unauthorized', () => {
    throw new HTTPException(401, { message: 'missing token' });
  });
  app.get('/conflict', () => {
    throw new HTTPException(409, { message: 'agent already exists' });
  });
  app.get('/teapot', () => {
    // 418 is not in our explicit map — verifies the 4xx fallback.
    throw new HTTPException(418, { message: 'no coffee here' });
  });
  app.get('/rate-limited', () => {
    // Idiomatic Hono pattern: pre-built Response carrying custom headers.
    // The handler must propagate those onto the JSON error response
    // (P.6 — previously `err.res` was silently dropped).
    throw new HTTPException(429, {
      message: 'rate limit exceeded',
      res: new Response(null, {
        status: 429,
        headers: { 'Retry-After': '42', 'X-RateLimit-Remaining': '0' },
      }),
    });
  });
  return app;
}

describe('error middleware', () => {
  it('/health returns {ok:true} with handlers attached', async () => {
    const app = makeRealApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('unhandled throw returns 500 with generic INTERNAL_ERROR shape', async () => {
    const app = makeThrowingApp();
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    // Internal message must NOT leak.
    expect(JSON.stringify(body)).not.toContain('top secret');
  });

  it('HTTPException 401 → UNAUTHORIZED with original message', async () => {
    const app = makeThrowingApp();
    const res = await app.request('/unauthorized');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'missing token' },
    });
  });

  it('HTTPException 409 → CONFLICT with original message', async () => {
    const app = makeThrowingApp();
    const res = await app.request('/conflict');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'CONFLICT', message: 'agent already exists' },
    });
  });

  it('HTTPException with unmapped 4xx falls back to BAD_REQUEST code', async () => {
    const app = makeThrowingApp();
    const res = await app.request('/teapot');
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'no coffee here' },
    });
  });

  it('HTTPException with err.res propagates custom headers (P.6)', async () => {
    const app = makeThrowingApp();
    const res = await app.request('/rate-limited');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    // JSON body contract still holds — err.res headers are merged in,
    // not used to replace the response body.
    expect(await res.json()).toEqual({
      error: { code: 'TOO_MANY_REQUESTS', message: 'rate limit exceeded' },
    });
    // Content-Type must remain JSON — c.json() owns it, err.res can't override.
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  it('unknown route returns 404 NOT_FOUND shape', async () => {
    const app = makeRealApp();
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/does-not-exist');
  });
});
