/**
 * Unit tests for the Privy auth middleware (task 3.3).
 *
 * The middleware takes an `AuthVerifier` as a dependency, so tests pass a
 * fake verifier and drive the full Hono request pipeline (including the
 * global error middleware) via `app.request()`. No network, no real JWTs.
 */

import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { type ApiEnv, requireAuth } from '../src/middleware/auth';
import { registerErrorHandlers } from '../src/middleware/error';

const silentLogger = pino({ level: 'silent' });

function makeApp(verifier: AuthVerifier) {
  const app = new Hono<ApiEnv>();
  registerErrorHandlers(app, silentLogger);
  app.use('/protected/*', requireAuth(verifier, silentLogger));
  app.get('/protected/me', (c) => c.json({ userId: c.get('userId') }));
  return app;
}

describe('auth middleware', () => {
  it('rejects request without Authorization header with 401', async () => {
    const verify = vi.fn();
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'missing authorization header' },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects malformed Authorization header with 401', async () => {
    const verify = vi.fn();
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Basic abc123' },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'malformed authorization header' },
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects token that the verifier rejects with 401', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('JWT expired'));
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Bearer stale-token' },
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'invalid token' },
    });
    expect(verify).toHaveBeenCalledWith('stale-token');
  });

  it('allows valid token and injects c.var.userId', async () => {
    const verify = vi.fn().mockResolvedValue({ userId: 'did:privy:user-42' });
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'did:privy:user-42' });
    expect(verify).toHaveBeenCalledWith('valid-token');
  });

  it('accepts the "bearer" scheme case-insensitively', async () => {
    const verify = vi.fn().mockResolvedValue({ userId: 'did:privy:user-7' });
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me', {
      headers: { Authorization: 'bearer abc123' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'did:privy:user-7' });
  });

  it('does not leak verifier error details to the client', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('internal Privy API key bad'));
    const verifier: AuthVerifier = { verify };
    const app = makeApp(verifier);

    const res = await app.request('/protected/me', {
      headers: { Authorization: 'Bearer whatever' },
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain('Privy API key');
    expect(body).not.toContain('internal');
  });
});
