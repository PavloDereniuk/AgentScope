/**
 * Integration tests for POST /v1/traces (tasks 4.2 + 4.3).
 *
 * Exercises the OTLP/HTTP JSON receiver end-to-end through the full
 * `buildApp()` pipeline. 4.2 landed with a stub db; 4.3 introduces
 * agent-token auth, so the tests now run against a real PGlite with
 * a seeded agent whose `ingest_token` we embed in every valid payload.
 *
 * A single PGlite + app instance is reused across the describe block
 * (`beforeAll` / `afterAll`) because every assertion is read-only at
 * the DB layer in 4.3 — nothing mutates state. This keeps the OTLP
 * suite fast (~3s for 14 tests) without sacrificing isolation.
 *
 * A capturing pino Writable stream records log entries so we can
 * assert on the receiver's structured output — both the inbound
 * span counts (4.2 acceptance) and the resolved agent id (4.3
 * acceptance).
 */

import { Writable } from 'node:stream';
import { agents, reasoningLogs, users } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import type { Logger } from '../src/logger';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

/** Fake Privy verifier — never called by /v1/traces, but buildApp wants one. */
const stubVerifier: AuthVerifier = {
  async verify() {
    return { userId: 'unused' };
  },
};

/** Build a pino instance that pushes every log record into an array. */
function makeCapturingLogger(): { logger: Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      try {
        records.push(JSON.parse(chunk.toString()));
      } catch {
        // pino emits ndjson; anything non-JSON (bootstrap noise) is ignored.
      }
      cb();
    },
  });
  const logger = pino({ level: 'info' }, stream) as unknown as Logger;
  return { logger, records };
}

interface TestCtx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  records: Array<Record<string, unknown>>;
  /** Valid `ingest_token` for the seeded agent — pre-registered in the DB. */
  validToken: string;
  /** Resolved agent.id for the seeded agent, for log assertions. */
  agentId: string;
  /** Resolved user.id (owner of the seeded agent). */
  userId: string;
}

/**
 * Bootstraps a PGlite + real buildApp, then seeds a single user +
 * agent directly via drizzle (bypassing the authenticated HTTP API,
 * which would require Privy stub plumbing we don't need here).
 */
async function setup(): Promise<TestCtx> {
  const testDb = await createTestDatabase();
  const { logger, records } = makeCapturingLogger();
  const app = buildApp({
    db: testDb.db,
    verifier: stubVerifier,
    sseBus: createSseBus(),
    logger,
  });

  const validToken = 'tok_otlp_receiver_test_token_abc123';

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:otlp-receiver-test' })
    .returning();
  if (!user) throw new Error('failed to seed user');

  const [agent] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'OTLP Receiver Test Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: validToken,
    })
    .returning();
  if (!agent) throw new Error('failed to seed agent');

  return { app, testDb, records, validToken, agentId: agent.id, userId: user.id };
}

/** Post an OTLP/HTTP JSON body and return the Response. */
async function postTraces(app: TestCtx['app'], body: unknown): Promise<Response> {
  return app.request('/v1/traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Hex-string span id helper — 16 lowercase hex chars (8 bytes). */
const spanId = (seed: string) => seed.padEnd(16, '0').slice(0, 16);
/** Hex-string trace id helper — 32 lowercase hex chars (16 bytes). */
const traceId = (seed: string) => seed.padEnd(32, '0').slice(0, 32);

/**
 * Build a minimal valid single-span payload carrying the given
 * `agent.token` on the first ResourceSpans' resource attributes.
 * Every field is overridable so individual tests can flip one thing
 * at a time to probe validation / auth boundaries.
 */
function onePayload(
  token: string,
  overrides: {
    traceId?: string;
    spanId?: string;
    name?: string;
    kind?: number;
    startTimeUnixNano?: string | number;
    endTimeUnixNano?: string | number;
  } = {},
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'agent.token', value: { stringValue: token } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: overrides.traceId ?? traceId('a1b2c3d4e5f6'),
                spanId: overrides.spanId ?? spanId('deadbeef'),
                name: overrides.name ?? 'agent.decide',
                kind: overrides.kind ?? 1,
                startTimeUnixNano: overrides.startTimeUnixNano ?? '1712577600000000000',
                endTimeUnixNano: overrides.endTimeUnixNano ?? '1712577601000000000',
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('POST /v1/traces', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await setup();
  });

  afterAll(async () => {
    await ctx.testDb.close();
  });

  beforeEach(async () => {
    // Drain captured logs so each test sees only its own output.
    ctx.records.length = 0;
    // Clean up persisted spans from prior tests (4.4 writes rows).
    await ctx.testDb.db.delete(reasoningLogs);
  });

  // ── 4.2 — schema validation + happy path ────────────────────────────

  it('accepts a minimal single-span payload and returns partialSuccess', async () => {
    const res = await postTraces(ctx.app, onePayload(ctx.validToken));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ partialSuccess: {} });
  });

  it('logs the inbound span/scope/resource counts at info level', async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a1'),
                  spanId: spanId('b1'),
                  name: 'a',
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                },
                {
                  traceId: traceId('a1'),
                  spanId: spanId('b2'),
                  name: 'b',
                  startTimeUnixNano: '3',
                  endTimeUnixNano: '4',
                },
              ],
            },
            {
              spans: [
                {
                  traceId: traceId('a1'),
                  spanId: spanId('b3'),
                  name: 'c',
                  startTimeUnixNano: '5',
                  endTimeUnixNano: '6',
                },
              ],
            },
          ],
        },
        {
          // A second ResourceSpans entry — the auth scan only looks
          // at the first, so leaving out a token here is fine.
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a2'),
                  spanId: spanId('b4'),
                  name: 'd',
                  startTimeUnixNano: '7',
                  endTimeUnixNano: '8',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(200);

    const summary = ctx.records.find((r) => r.msg === 'otlp traces received');
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      resourceSpansCount: 2,
      scopeSpansCount: 3,
      spanCount: 4,
    });
  });

  it('accepts recursive AnyValue attributes (kvlist containing array)', async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a1b2c3d4e5f6'),
                  spanId: spanId('deadbeef'),
                  name: 'agent.decide',
                  kind: 1,
                  startTimeUnixNano: '1712577600000000000',
                  endTimeUnixNano: '1712577601000000000',
                  attributes: [
                    {
                      key: 'tool.input',
                      value: {
                        kvlistValue: {
                          values: [
                            {
                              key: 'prompts',
                              value: {
                                arrayValue: {
                                  values: [{ stringValue: 'hello' }, { stringValue: 'world' }],
                                },
                              },
                            },
                            {
                              key: 'temperature',
                              value: { doubleValue: 0.7 },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(200);
  });

  it('accepts startTimeUnixNano as a plain JS number (coerces to string)', async () => {
    const res = await postTraces(
      ctx.app,
      onePayload(ctx.validToken, {
        startTimeUnixNano: 1_712_577_600_000,
        endTimeUnixNano: 1_712_577_601_000,
      }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 422 when traceId is not 32 hex chars', async () => {
    const res = await postTraces(ctx.app, onePayload(ctx.validToken, { traceId: 'tooshort' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(body.error.message).toContain('traceId');
  });

  it('returns 422 when spanId contains non-hex characters', async () => {
    const res = await postTraces(
      ctx.app,
      onePayload(ctx.validToken, { spanId: 'ZZZZZZZZZZZZZZZZ' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('spanId');
  });

  it('returns 422 when span.kind is out of 0..5 range', async () => {
    const res = await postTraces(ctx.app, onePayload(ctx.validToken, { kind: 9 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('kind');
  });

  it('returns 422 when span.name is missing', async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a1b2c3d4e5f6'),
                  spanId: spanId('deadbeef'),
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('name');
  });

  it('returns 422 when startTimeUnixNano is a non-numeric string', async () => {
    const res = await postTraces(
      ctx.app,
      onePayload(ctx.validToken, { startTimeUnixNano: 'not-a-number' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('startTimeUnixNano');
  });

  it('returns 422 for unknown fields at the span level (strict schema)', async () => {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a1b2c3d4e5f6'),
                  spanId: spanId('deadbeef'),
                  name: 'agent.decide',
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                  mysteryField: 'rejected',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(422);
  });

  // ── 4.3 — agent.token auth ──────────────────────────────────────────

  it('returns 401 when the resource carries no attributes at all', async () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: traceId('a1b2c3d4e5f6'),
                  spanId: spanId('deadbeef'),
                  name: 'agent.decide',
                  startTimeUnixNano: '1',
                  endTimeUnixNano: '2',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('agent.token');
  });

  it('returns 401 when agent.token is an empty string', async () => {
    const res = await postTraces(ctx.app, onePayload(''));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when agent.token does not match any agent', async () => {
    const res = await postTraces(ctx.app, onePayload('tok_nobody_owns_this_one'));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(body.error.message).toContain('invalid');
  });

  it('logs the resolved agentId and userId on a successful call', async () => {
    const res = await postTraces(ctx.app, onePayload(ctx.validToken));
    expect(res.status).toBe(200);

    const summary = ctx.records.find((r) => r.msg === 'otlp traces received');
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      agentId: ctx.agentId,
      userId: ctx.userId,
    });
  });

  it('returns 422 (not 401) for a malformed body even when a valid token could be extracted later', async () => {
    // Schema validation runs first, so a short traceId fails before
    // auth ever gets to look at the resource attributes. This matters
    // because auth is the more expensive check (DB round-trip) and
    // we don't want malformed payloads hitting the DB.
    const res = await postTraces(ctx.app, onePayload(ctx.validToken, { traceId: 'short' }));
    expect(res.status).toBe(422);
  });

  // ── 4.4 — span persistence ──────────────────────────────────────────

  it('persists a 3-span trace as 3 rows in reasoning_logs', async () => {
    const tid = traceId('aabbccddee');
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('1111111111111111'),
                  name: 'span-a',
                  startTimeUnixNano: '1712577600000000000',
                  endTimeUnixNano: '1712577601000000000',
                },
                {
                  traceId: tid,
                  spanId: spanId('2222222222222222'),
                  parentSpanId: spanId('1111111111111111'),
                  name: 'span-b',
                  startTimeUnixNano: '1712577600500000000',
                  endTimeUnixNano: '1712577600800000000',
                },
              ],
            },
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('3333333333333333'),
                  name: 'span-c',
                  startTimeUnixNano: '1712577601000000000',
                  endTimeUnixNano: '1712577602000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(200);

    const rows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.agentId, ctx.agentId));

    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.spanName).sort();
    expect(names).toEqual(['span-a', 'span-b', 'span-c']);
  });

  it('stores parentSpanId when present, null when absent', async () => {
    const tid = traceId('ab0c0d0e0f111122');
    const parentSid = spanId('aaaaaaaaaaaaaaaa');
    const childSid = spanId('bbbbbbbbbbbbbbbb');
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: parentSid,
                  name: 'parent',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
                {
                  traceId: tid,
                  spanId: childSid,
                  parentSpanId: parentSid,
                  name: 'child',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    await postTraces(ctx.app, payload);
    const rows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    const parent = rows.find((r) => r.spanName === 'parent');
    const child = rows.find((r) => r.spanName === 'child');
    expect(parent?.parentSpanId).toBeNull();
    expect(child?.parentSpanId).toBe(parentSid);
  });

  it('flattens nested AnyValue attributes into jsonb', async () => {
    const tid = traceId('f1a3e50000000000');
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('cccccccccccccccc'),
                  name: 'attr-test',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [
                    { key: 'simple', value: { stringValue: 'hello' } },
                    { key: 'count', value: { intValue: '42' } },
                    {
                      key: 'nested',
                      value: {
                        kvlistValue: {
                          values: [
                            { key: 'a', value: { boolValue: true } },
                            {
                              key: 'arr',
                              value: {
                                arrayValue: {
                                  values: [{ doubleValue: 1.5 }, { stringValue: 'x' }],
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await postTraces(ctx.app, payload);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    const attrs = row?.attributes as Record<string, unknown>;
    expect(attrs.simple).toBe('hello');
    expect(attrs.count).toBe('42');
    expect(attrs.nested).toEqual({ a: true, arr: [1.5, 'x'] });
  });

  it('stores otel.kind and otel.status_code in attributes jsonb', async () => {
    const tid = traceId('0e1a2b3c4d5e6f00');
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('dddddddddddddddd'),
                  name: 'otel-meta',
                  kind: 2,
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  status: { code: 2, message: 'something broke' },
                },
              ],
            },
          ],
        },
      ],
    };

    await postTraces(ctx.app, payload);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    const attrs = row?.attributes as Record<string, unknown>;
    expect(attrs['otel.kind']).toBe(2);
    expect(attrs['otel.status_code']).toBe(2);
    expect(attrs['otel.status_message']).toBe('something broke');
  });

  it('converts nanosecond timestamps to correct ISO-8601 strings', async () => {
    // 1712577600000000000 ns = 1712577600000 ms = 2024-04-08T12:00:00.000Z
    const tid = traceId('1a2b3c4d5e6f7a8b');
    const payload = onePayload(ctx.validToken, {
      traceId: tid,
      spanId: spanId('eeeeeeeeeeeeeeee'),
      startTimeUnixNano: '1712577600000000000',
      endTimeUnixNano: '1712577601500000000',
    });

    await postTraces(ctx.app, payload);
    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    // PGlite returns timestamptz in PG native format, not ISO-8601.
    // Compare as Date objects to avoid format sensitivity.
    expect(row).toBeDefined();
    expect(new Date(row?.startTime ?? '').getTime()).toBe(1712577600000);
    expect(new Date(row?.endTime ?? '').getTime()).toBe(1712577601500);
  });

  it('skips duplicate spans on retry without error (idempotent)', async () => {
    const payload = onePayload(ctx.validToken, {
      traceId: traceId('d0de000000000000'),
      spanId: spanId('ffffffffffffffff'),
    });

    const res1 = await postTraces(ctx.app, payload);
    expect(res1.status).toBe(200);

    const res2 = await postTraces(ctx.app, payload);
    expect(res2.status).toBe(200);

    const rows = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, traceId('d0de000000000000')));
    expect(rows).toHaveLength(1);
  });

  it('logs the persisted count in the summary record', async () => {
    const res = await postTraces(ctx.app, onePayload(ctx.validToken));
    expect(res.status).toBe(200);

    const summary = ctx.records.find((r) => r.msg === 'otlp traces received');
    expect(summary).toMatchObject({ persisted: expect.any(Number) });
  });

  // ── 4.5 — tx signature correlation ────────────────────────────────

  it('extracts solana.tx.signature attribute into tx_signature column', async () => {
    const tid = traceId('aa00bb00cc00dd00');
    const sig = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQTnFg';
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('a1a1a1a1a1a1a1a1'),
                  name: 'solana.sendTransaction',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                  attributes: [
                    { key: 'solana.tx.signature', value: { stringValue: sig } },
                    { key: 'other', value: { stringValue: 'ignored' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(200);

    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    expect(row?.txSignature).toBe(sig);
  });

  it('leaves tx_signature null when solana.tx.signature is absent', async () => {
    const tid = traceId('bb00cc00dd00ee00');
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'agent.token', value: { stringValue: ctx.validToken } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: tid,
                  spanId: spanId('b2b2b2b2b2b2b2b2'),
                  name: 'agent.think',
                  startTimeUnixNano: '1000000000',
                  endTimeUnixNano: '2000000000',
                },
              ],
            },
          ],
        },
      ],
    };

    const res = await postTraces(ctx.app, payload);
    expect(res.status).toBe(200);

    const [row] = await ctx.testDb.db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, tid));

    expect(row?.txSignature).toBeNull();
  });
});
