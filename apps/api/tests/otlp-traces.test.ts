/**
 * Integration tests for POST /v1/traces (task 4.2).
 *
 * Exercises the OTLP/HTTP JSON receiver end-to-end through the full
 * `buildApp()` pipeline. Stubs db/verifier because this route never
 * touches either (auth lands in 4.3, persistence in 4.4) — keeping
 * the tests cheap (no PGlite spin-up).
 *
 * A capturing pino stream records log entries so we can assert that
 * the receiver logs the inbound span counts, which is the acceptance
 * check on the task.
 */

import { Writable } from 'node:stream';
import type { Database } from '@agentscope/db';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { createSseBus } from '../src/lib/sse-bus';
import type { Logger } from '../src/logger';

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

interface TestApp {
  app: ReturnType<typeof buildApp>;
  records: Array<Record<string, unknown>>;
}

function setup(): TestApp {
  const { logger, records } = makeCapturingLogger();
  const app = buildApp({
    db: {} as unknown as Database,
    verifier: stubVerifier,
    sseBus: createSseBus(),
    logger,
  });
  return { app, records };
}

/** Post an OTLP/HTTP JSON body and return the Response. */
async function postTraces(app: TestApp['app'], body: unknown): Promise<Response> {
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

/** Build a minimal valid single-span payload, overridable per test. */
function onePayload(
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
  let ctx: TestApp;

  beforeEach(() => {
    ctx = setup();
  });

  it('accepts a minimal single-span payload and returns partialSuccess', async () => {
    const res = await postTraces(ctx.app, onePayload());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ partialSuccess: {} });
  });

  it('logs the inbound span/scope/resource counts at info level', async () => {
    const payload = {
      resourceSpans: [
        {
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

  it('accepts a completely empty body {} as a valid no-op', async () => {
    const res = await postTraces(ctx.app, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ partialSuccess: {} });

    const summary = ctx.records.find((r) => r.msg === 'otlp traces received');
    expect(summary).toMatchObject({ resourceSpansCount: 0, scopeSpansCount: 0, spanCount: 0 });
  });

  it('accepts recursive AnyValue attributes (kvlist containing array)', async () => {
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
      onePayload({ startTimeUnixNano: 1_712_577_600_000, endTimeUnixNano: 1_712_577_601_000 }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 422 when traceId is not 32 hex chars', async () => {
    const res = await postTraces(ctx.app, onePayload({ traceId: 'tooshort' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(body.error.message).toContain('traceId');
  });

  it('returns 422 when spanId contains non-hex characters', async () => {
    const res = await postTraces(ctx.app, onePayload({ spanId: 'ZZZZZZZZZZZZZZZZ' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('spanId');
  });

  it('returns 422 when span.kind is out of 0..5 range', async () => {
    const res = await postTraces(ctx.app, onePayload({ kind: 9 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('kind');
  });

  it('returns 422 when span.name is missing', async () => {
    // Build the payload directly so we can omit `name` without tripping
    // the helper's type or noUncheckedIndexedAccess.
    const payload = {
      resourceSpans: [
        {
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
    const res = await postTraces(ctx.app, onePayload({ startTimeUnixNano: 'not-a-number' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('startTimeUnixNano');
  });

  it('returns 422 for unknown fields at the span level (strict schema)', async () => {
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
});
