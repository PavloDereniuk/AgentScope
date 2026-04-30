/**
 * Integration tests for POST /v1/spans (Epic 15 — L0 REST ingest).
 *
 * Mirrors the OTLP suite's setup pattern: one shared PGlite + buildApp
 * across the describe block, agent seeded directly via drizzle, span
 * cleanup in `beforeEach`. The L0 route reuses the OTLP persister's
 * `reasoning_logs` row layout, so we assert at the row level rather
 * than the API response shape — proving the dashboard renders L0 spans
 * exactly the same as L2/SDK spans.
 */

import { agents, reasoningLogs, users } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import { createRateLimiter } from '../src/middleware/rate-limit';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const stubVerifier: AuthVerifier = {
  async verify() {
    return { userId: 'unused' };
  },
};

const silentLogger = pino({ level: 'silent' });

interface TestCtx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  validToken: string;
  agentId: string;
  userId: string;
}

async function setup(): Promise<TestCtx> {
  const testDb = await createTestDatabase();
  const app = buildApp({
    db: testDb.db,
    verifier: stubVerifier,
    sseBus: createSseBus(),
    logger: silentLogger,
  });

  const validToken = 'tok_l0_ingest_test_token_xyz';

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:l0-ingest-test' })
    .returning();
  if (!user) throw new Error('failed to seed user');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'L0 Ingest Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: validToken,
    })
    .returning();
  if (!agent) throw new Error('failed to seed agent');

  return { app, testDb, validToken, agentId: agent.id, userId: user.id };
}

async function postSpan(
  app: TestCtx['app'],
  body: unknown,
  opts: { token?: string | null; auth?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.auth !== undefined) {
    headers.Authorization = opts.auth;
  } else if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? ''}`;
  }
  return app.request('/v1/spans', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const traceId = (seed: string) => seed.padEnd(32, '0').slice(0, 32);
const spanId = (seed: string) => seed.padEnd(16, '0').slice(0, 16);

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    traceId: traceId('a1b2c3d4e5f6'),
    spanId: spanId('deadbeef'),
    name: 'agent.decide',
    startTime: '2026-04-30T12:00:00.000Z',
    endTime: '2026-04-30T12:00:01.000Z',
    ...overrides,
  };
}

describe('POST /v1/spans', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(async () => {
    await ctx.testDb.close();
  });

  beforeEach(async () => {
    await ctx.testDb.db.delete(reasoningLogs);
  });

  // ── happy path ───────────────────────────────────────────────────

  it('persists a single span and returns inserted: 1', async () => {
    const res = await postSpan(ctx.app, basePayload(), { token: ctx.validToken });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1 });

    const rows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.agentId, ctx.agentId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.traceId).toBe(traceId('a1b2c3d4e5f6'));
    expect(row?.spanId).toBe(spanId('deadbeef'));
    expect(row?.spanName).toBe('agent.decide');
    expect(row?.parentSpanId).toBeNull();
    expect(row?.txSignature).toBeNull();
    // Timestamps round-trip through ISO 8601 → PG timestamptz; compare
    // as Date to stay format-agnostic across PGlite vs Postgres output.
    expect(new Date(row?.startTime ?? '').getTime()).toBe(
      new Date('2026-04-30T12:00:00.000Z').getTime(),
    );
    expect(new Date(row?.endTime ?? '').getTime()).toBe(
      new Date('2026-04-30T12:00:01.000Z').getTime(),
    );
  });

  it('accepts Unix epoch milliseconds as timestamps', async () => {
    const startMs = Date.UTC(2026, 3, 30, 14, 0, 0);
    const endMs = startMs + 500;
    const tid = traceId('1234abcd5678');
    const res = await postSpan(
      ctx.app,
      basePayload({
        traceId: tid,
        spanId: spanId('11112222'),
        startTime: startMs,
        endTime: endMs,
      }),
      { token: ctx.validToken },
    );

    expect(res.status).toBe(200);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));
    expect(new Date(row?.startTime ?? '').getTime()).toBe(startMs);
    expect(new Date(row?.endTime ?? '').getTime()).toBe(endMs);
  });

  it('preserves attributes and adds otel.* keys from kind/status', async () => {
    const tid = traceId('aaaabbbb');
    const res = await postSpan(
      ctx.app,
      basePayload({
        traceId: tid,
        spanId: spanId('cccc'),
        attributes: { 'reasoning.input': 'hi', count: 42, nested: { a: true } },
        kind: 2,
        status: { code: 2, message: 'oops' },
      }),
      { token: ctx.validToken },
    );

    expect(res.status).toBe(200);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));
    const attrs = row?.attributes as Record<string, unknown>;
    expect(attrs['reasoning.input']).toBe('hi');
    expect(attrs.count).toBe(42);
    expect(attrs.nested).toEqual({ a: true });
    expect(attrs['otel.kind']).toBe(2);
    expect(attrs['otel.status_code']).toBe(2);
    expect(attrs['otel.status_message']).toBe('oops');
  });

  it('persists txSignature when present (E15 acceptance gate — tx ↔ span correlation)', async () => {
    const tid = traceId('aabbccdd');
    const sig = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQTnFg';
    const res = await postSpan(
      ctx.app,
      basePayload({ traceId: tid, spanId: spanId('1111'), txSignature: sig }),
      { token: ctx.validToken },
    );

    expect(res.status).toBe(200);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));
    expect(row?.txSignature).toBe(sig);
  });

  it('is idempotent on retry — duplicate (traceId, spanId) returns inserted: 0', async () => {
    const payload = basePayload({
      traceId: traceId('dedededede'),
      spanId: spanId('ffffffff'),
    });

    const first = await postSpan(ctx.app, payload, { token: ctx.validToken });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inserted: 1 });

    const second = await postSpan(ctx.app, payload, { token: ctx.validToken });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ inserted: 0 });

    const rows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, traceId('dedededede')));
    expect(rows).toHaveLength(1);
  });

  it('records parent_span_id when supplied', async () => {
    const tid = traceId('99887766');
    const parentSid = spanId('aaaaaaaa');
    const res = await postSpan(
      ctx.app,
      basePayload({
        traceId: tid,
        spanId: spanId('bbbbbbbb'),
        parentSpanId: parentSid,
        name: 'child',
      }),
      { token: ctx.validToken },
    );

    expect(res.status).toBe(200);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));
    expect(row?.parentSpanId).toBe(parentSid);
  });

  // ── auth ─────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await postSpan(ctx.app, basePayload(), { token: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('Bearer');
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await postSpan(ctx.app, basePayload(), { auth: 'Basic dXNlcjpwYXNz' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer token does not match any agent', async () => {
    const res = await postSpan(ctx.app, basePayload(), { token: 'tok_nobody_owns_this' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('invalid');
  });

  // ── validation ──────────────────────────────────────────────────

  it('returns 422 when traceId is not 32 lowercase hex chars', async () => {
    const res = await postSpan(ctx.app, basePayload({ traceId: 'short' }), {
      token: ctx.validToken,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('traceId');
  });

  it('returns 422 when spanId contains non-hex characters', async () => {
    const res = await postSpan(ctx.app, basePayload({ spanId: 'ZZZZZZZZZZZZZZZZ' }), {
      token: ctx.validToken,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('spanId');
  });

  it('returns 422 when name is empty', async () => {
    const res = await postSpan(ctx.app, basePayload({ name: '' }), { token: ctx.validToken });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('name');
  });

  it('returns 422 when timestamp is neither ISO 8601 nor a number', async () => {
    const res = await postSpan(ctx.app, basePayload({ startTime: 'yesterday' }), {
      token: ctx.validToken,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('startTime');
  });

  it('returns 422 when txSignature is not a valid Solana signature', async () => {
    const res = await postSpan(ctx.app, basePayload({ txSignature: 'not-a-real-sig' }), {
      token: ctx.validToken,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('txSignature');
  });

  it('returns 422 for unknown top-level fields (strict schema)', async () => {
    const res = await postSpan(
      ctx.app,
      { ...basePayload(), mysteryField: 'rejected' },
      { token: ctx.validToken },
    );
    expect(res.status).toBe(422);
  });

  it('returns 422 (not 401) when body is malformed even with a valid token', async () => {
    // Validation runs before auth so malformed payloads never touch the
    // DB. Mirrors the OTLP receiver's order-of-operations contract.
    const res = await postSpan(ctx.app, basePayload({ traceId: 'bad' }), {
      token: ctx.validToken,
    });
    expect(res.status).toBe(422);
  });
});

// Rate limiting is opt-in via the same limiter wired for /v1/traces
// in production. A single dedicated test asserts the integration —
// the limiter's math is already covered by `rate-limit.test.ts`.
describe('POST /v1/spans rate limit', () => {
  it('returns 429 with Retry-After once the per-token budget is exhausted', async () => {
    const testDb = await createTestDatabase();
    try {
      const validToken = 'tok_l0_ratelimit_test';
      const [user] = await testDb.db
        .insert(users)
        .values({ privyDid: 'did:privy:l0-ratelimit' })
        .returning();
      if (!user) throw new Error('failed to seed user');
      await testDb.db
        .insert(agents)
        .values({
          userId: user.id,
          walletPubkey: '22222222222222222222222222222222',
          name: 'L0 RL Agent',
          framework: 'custom',
          agentType: 'other',
          ingestToken: validToken,
        })
        .returning();

      const app = buildApp({
        db: testDb.db,
        verifier: stubVerifier,
        sseBus: createSseBus(),
        logger: silentLogger,
        // Tight 2-call budget to exercise the 429 path quickly. In
        // production this is the same 100/min limiter that /v1/traces
        // uses, sharing budget with the OTLP receiver.
        otlpLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
      });

      const send = (sid: string) =>
        app.request('/v1/spans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${validToken}` },
          body: JSON.stringify(basePayload({ spanId: spanId(sid) })),
        });

      expect((await send('aaaa')).status).toBe(200);
      expect((await send('bbbb')).status).toBe(200);
      const blocked = await send('cccc');
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
    } finally {
      await testDb.close();
    }
  });
});
