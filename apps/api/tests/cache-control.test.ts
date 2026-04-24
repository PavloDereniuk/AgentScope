/**
 * Regression tests for the authenticated-response cache policy.
 *
 * Railway fronts the API with a Fastly edge. Without an explicit
 * `Cache-Control` directive, Fastly cached authenticated 200 responses
 * and served stale per-user data across requests — which is exactly
 * how the dashboard ended up pinned to a pre-cleanup tx count.
 *
 * These tests pin the contract end-to-end against `buildApp` so an
 * accidental removal of the middleware fails CI rather than production.
 */

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });
const BEARER = 'Bearer stub-token';

function makeVerifier(userId = 'did:privy:user-42'): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

interface Ctx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function setup(): Promise<Ctx> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: makeVerifier(),
    sseBus: createSseBus(),
    logger: silentLogger,
  });
  return { app, testDb };
}

describe('authenticated response cache policy', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('sets Cache-Control: private, no-store on successful /api responses', async () => {
    const res = await ctx.app.request('/api/health', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('sets Vary: Authorization so shared caches never mix tokens', async () => {
    const res = await ctx.app.request('/api/health', {
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(200);
    // The header may list additional axes (Origin from CORS); the contract
    // is that `Authorization` is always one of them.
    expect(res.headers.get('Vary')).toMatch(/(^|,\s*)Authorization(,|$)/);
  });

  it('applies the same policy to 401 responses so rejections cannot be replayed from a CDN', async () => {
    const res = await ctx.app.request('/api/health');
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('leaves the unauthenticated /health probe untouched (public, Railway liveness)', async () => {
    const res = await ctx.app.request('/health');
    expect(res.status).toBe(200);
    // The top-level /health is not under /api and must stay cacheable-by-default
    // so Railway's uptime checks and Fastly probes don't add unnecessary churn.
    expect(res.headers.get('Cache-Control')).toBeNull();
  });
});
