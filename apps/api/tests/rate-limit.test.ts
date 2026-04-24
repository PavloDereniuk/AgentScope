/**
 * Unit + integration tests for the rate-limit middleware (task 14.13).
 *
 * Unit: limiter math (window reset, retryAfter, LRU eviction).
 * Integration: real Hono request → 429 + Retry-After on the 11th
 * agent-create from the same user inside an hour.
 */

import { Hono } from 'hono';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import type { ApiEnv } from '../src/middleware/auth';
import { createRateLimiter, rateLimitMiddleware } from '../src/middleware/rate-limit';
import { createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

describe('createRateLimiter', () => {
  it('allows up to `limit` calls per window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(true);
    const blocked = limiter.take('k');
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('decreases `remaining` per call', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.take('k').remaining).toBe(1);
    expect(limiter.take('k').remaining).toBe(0);
  });

  it('isolates keys', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('b').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('refills after the window passes', () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
      expect(limiter.take('k').ok).toBe(true);
      expect(limiter.take('k').ok).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(limiter.take('k').ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts oldest key once maxKeys is reached', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    limiter.take('a');
    limiter.take('b');
    // Adding a third should evict 'a'.
    limiter.take('c');
    // 'a' is gone — its first new call should succeed (fresh bucket).
    expect(limiter.take('a').ok).toBe(true);
  });
});

describe('rateLimitMiddleware', () => {
  it('returns 429 with Retry-After header when limit hit', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const verifier: AuthVerifier = { verify: async () => ({ userId: 'did:privy:x' }) };
    const app = new Hono<ApiEnv>();
    app.use('*', async (c, next) => {
      // stub auth so getKey can pull a userId from c
      c.set('userId', 'did:privy:x');
      await next();
    });
    app.use(
      '*',
      rateLimitMiddleware(limiter, (c) => c.get('userId') ?? null),
    );
    app.get('/x', (c) => c.text('ok'));

    expect((await app.request('/x')).status).toBe(200);
    const blocked = await app.request('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    void verifier;
  });

  it('is a no-op when getKey returns null', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const app = new Hono<ApiEnv>();
    app.use(
      '*',
      rateLimitMiddleware(limiter, () => null),
    );
    app.get('/x', (c) => c.text('ok'));

    for (let i = 0; i < 5; i++) {
      expect((await app.request('/x')).status).toBe(200);
    }
  });
});

describe('integration: POST /api/agents enforces 10/hour', () => {
  it('11th agent-create from the same user is 429', async () => {
    const testDb = await createTestDatabase();
    try {
      const verifier: AuthVerifier = { verify: async () => ({ userId: 'did:privy:limit-user' }) };
      const app = buildApp({
        db: testDb.db,
        verifier,
        sseBus: createSseBus(),
        logger: silentLogger,
        // Use the production limit of 10/hour explicitly so the test
        // documents the intended budget rather than relying on app defaults.
        agentCreateLimiter: createRateLimiter({ limit: 10, windowMs: 60 * 60_000 }),
      });

      // 32-char base58 wallets; vary the first char to keep them distinct
      // (the unique index is on (user_id, wallet_pubkey)).
      const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      const create = (i: number) =>
        app.request('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
          body: JSON.stringify({
            walletPubkey: `${BASE58_CHARS[i % BASE58_CHARS.length]}${'1'.repeat(31)}`,
            name: `Agent ${i}`,
            framework: 'custom',
            agentType: 'other',
          }),
        });

      for (let i = 0; i < 10; i++) {
        const res = await create(i);
        expect(res.status, `create ${i}`).toBe(201);
      }
      const blocked = await create(99);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
    } finally {
      await testDb.close();
    }
  });
});
