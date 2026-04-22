/**
 * Integration tests for POST /api/agents/:id/test-alert (task 13.7).
 *
 * Full buildApp pipeline over PGlite + fake verifier + fake Telegram
 * channel sender. Verifies:
 *   - ownership enforcement (404 for foreign / unknown agents)
 *   - deliver() called exactly once with a payload matching the target agent
 *   - error pass-through when the sender reports a failure
 *   - graceful `{ok: false}` response when no alerter is configured
 *   - no row written to `alerts` — the feed stays clean
 */

import { alerts } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:test-alert';
const BEARER = 'Bearer stub-token';

function makeVerifier(userId: string = PRIVY_DID): AuthVerifier {
  return {
    async verify() {
      return { userId };
    },
  };
}

interface TestApp {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  sendMock: ReturnType<typeof vi.fn>;
}

async function setup(
  opts: { sendResult?: { success: boolean; error?: string }; withAlerter?: boolean } = {},
): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const sendMock = vi.fn().mockResolvedValue({
    channel: 'telegram',
    ...(opts.sendResult ?? { success: true }),
  });
  const app = buildApp({
    db: testDb.db,
    verifier: makeVerifier(),
    sseBus: createSseBus(),
    logger: silentLogger,
    ...(opts.withAlerter === false ? {} : { alerter: { telegram: { send: sendMock } } }),
  });
  return { app, testDb, sendMock };
}

async function createAgent(ctx: TestApp, name: string, walletPubkey: string): Promise<string> {
  const res = await ctx.app.request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: BEARER },
    body: JSON.stringify({ walletPubkey, name, framework: 'custom', agentType: 'other' }),
  });
  if (res.status !== 201) throw new Error(`seed create failed: ${res.status}`);
  const body = (await res.json()) as { agent: { id: string } };
  return body.agent.id;
}

function post(ctx: TestApp, id: string, token = BEARER) {
  return ctx.app.request(`/api/agents/${id}/test-alert`, {
    method: 'POST',
    headers: { Authorization: token },
  });
}

describe('POST /api/agents/:id/test-alert', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const agentId = await createAgent(ctx, 'A', 'So11111111111111111111111111111111111111112');
    const res = await ctx.app.request(`/api/agents/${agentId}/test-alert`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 422 for a non-uuid id', async () => {
    const res = await post(ctx, 'not-a-uuid');
    expect(res.status).toBe(422);
  });

  it('returns 404 for an unknown but well-formed id', async () => {
    const res = await post(ctx, '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the agent belongs to another user', async () => {
    const agentId = await createAgent(ctx, 'Alice', 'So11111111111111111111111111111111111111112');

    const bob = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:bob'),
      sseBus: createSseBus(),
      logger: silentLogger,
      alerter: { telegram: { send: vi.fn() } },
    });
    const res = await bob.request(`/api/agents/${agentId}/test-alert`, {
      method: 'POST',
      headers: { Authorization: BEARER },
    });
    expect(res.status).toBe(404);
  });

  it('invokes deliver() once with a payload matching the agent', async () => {
    const agentId = await createAgent(ctx, 'Smoke', 'So11111111111111111111111111111111111111112');
    const res = await post(ctx, agentId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; delivered: boolean };
    expect(body).toEqual({ ok: true, delivered: true });

    expect(ctx.sendMock).toHaveBeenCalledTimes(1);
    const [msg] = ctx.sendMock.mock.calls[0] ?? [];
    expect(msg).toMatchObject({
      agentId,
      agentName: 'Smoke',
      ruleName: 'test_alert',
      severity: 'info',
      payload: expect.objectContaining({ isTest: true }),
    });
  });

  it('returns 502 when the sender reports a downstream failure', async () => {
    const failing = await setup({ sendResult: { success: false, error: 'chat not found' } });
    const agentId = await createAgent(
      failing,
      'Failing',
      'So11111111111111111111111111111111111111112',
    );
    const res = await post(failing, agentId);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('chat not found');
    await failing.testDb.close();
  });

  it('returns 503 when no alerter is configured on the server', async () => {
    const noAlerter = await setup({ withAlerter: false });
    const agentId = await createAgent(
      noAlerter,
      'No Alerter',
      'So11111111111111111111111111111111111111112',
    );
    const res = await post(noAlerter, agentId);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toMatch(/not configured/i);
    await noAlerter.testDb.close();
  });

  it('does not persist any row to the alerts table', async () => {
    const agentId = await createAgent(ctx, 'Clean', 'So11111111111111111111111111111111111111112');
    await post(ctx, agentId);
    const rows = await ctx.testDb.db.select().from(alerts);
    expect(rows).toEqual([]);
  });
});
