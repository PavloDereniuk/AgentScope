/**
 * Integration tests for the paid-plan request routes (roadmap H.1).
 */

import { upgradeRequests } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const BEARER = 'Bearer stub-token';

/** Verifier that maps the bearer token straight to a Privy DID. */
const verifier: AuthVerifier = {
  async verify(token: string) {
    return { userId: token === 'other-token' ? 'did:privy:other' : 'did:privy:upgrade-user' };
  },
};

const VALID = {
  plan: 'pro',
  contact: 'builder@example.com',
  agentCount: 8,
  useCase: 'Running a fleet of Jupiter DCA bots',
};

let testDb: TestDatabase;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  testDb = await createTestDatabase();
  app = buildApp({ db: testDb.db, verifier, sseBus: createSseBus(), logger: silentLogger });
});

afterEach(async () => {
  await testDb.close();
});

function put(body: unknown, auth = BEARER) {
  return app.request('/api/upgrade-request', {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(auth = BEARER) {
  return app.request('/api/upgrade-request', { headers: { Authorization: auth } });
}

describe('GET /api/upgrade-request', () => {
  it('returns null before the user has asked', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request: null });
  });

  it('requires auth', async () => {
    const res = await app.request('/api/upgrade-request');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/upgrade-request', () => {
  it('stores the request and returns it on GET', async () => {
    const res = await put(VALID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: Record<string, unknown> };
    expect(body.request).toMatchObject(VALID);

    const again = (await (await get()).json()) as { request: Record<string, unknown> };
    expect(again.request).toMatchObject(VALID);
  });

  it('upserts one row per user and re-queues the admin ping', async () => {
    await put(VALID);
    await testDb.db.update(upgradeRequests).set({ notifiedAt: new Date().toISOString() });

    const res = await put({ ...VALID, plan: 'team', agentCount: 40 });
    expect(res.status).toBe(200);

    const rows = await testDb.db.select().from(upgradeRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plan: 'team', agentCount: 40, notifiedAt: null });
  });

  it('keeps requests isolated per user', async () => {
    await put(VALID);
    const other = (await (await get('Bearer other-token')).json()) as { request: unknown };
    expect(other.request).toBeNull();
  });

  it.each([
    ['unknown plan', { ...VALID, plan: 'enterprise' }],
    ['short contact', { ...VALID, contact: 'ab' }],
    ['zero agents', { ...VALID, agentCount: 0 }],
    ['fractional agents', { ...VALID, agentCount: 2.5 }],
    ['blank use case', { ...VALID, useCase: '   ' }],
    ['oversized use case', { ...VALID, useCase: 'x'.repeat(1001) }],
  ])('rejects %s with 422', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(422);
    expect(await testDb.db.select().from(upgradeRequests)).toHaveLength(0);
  });
});
