/**
 * Integration tests for GET /api/stream (task 13.13).
 *
 * Verifies the global per-user SSE fan-out: two agents owned by the
 * same user produce two events in a single connection; a new agent
 * created AFTER the stream opens is picked up without reconnect; a
 * different user's events never leak across.
 *
 * We interact with the stream by calling `buildApp(...).request(...)`
 * directly and reading the ReadableStream body — PGlite + Hono run in
 * the same process, so no real HTTP server is needed.
 */

import { agents } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import type { AuthVerifier } from '../src/lib/auth-verifier';
import { type SseBus, createSseBus } from '../src/lib/sse-bus';
import { ensureUser } from '../src/lib/users';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const PRIVY_DID = 'did:privy:user-42';
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
  bus: SseBus;
  testDb: TestDatabase;
}

async function setup(verifier: AuthVerifier = makeVerifier()): Promise<TestApp> {
  const testDb = await createTestDatabase();
  const bus = createSseBus();
  const app = buildApp({ db: testDb.db, verifier, sseBus: bus, logger: silentLogger });
  return { app, bus, testDb };
}

/**
 * Open the /api/stream connection and return a reader that yields the
 * JSON frames decoded from the text/event-stream body. The reader
 * stops once we've collected `count` events (plus the initial
 * handshake) — each test knows exactly how many it needs.
 */
async function collectEvents(
  app: ReturnType<typeof buildApp>,
  count: number,
  publish: () => void | Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const controller = new AbortController();
  const res = await app.request('/api/stream', {
    headers: { Authorization: BEARER },
    signal: controller.signal,
  });
  if (!res.body) throw new Error('no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';

  // Kick publishers AFTER the stream is opened so we know the
  // subscribeUser handler is registered before events arrive.
  await publish();

  // The handshake frame is delivered in start() so it's already in
  // the pipe before the first read; pull frames until we have the
  // expected count plus the `connected` handshake.
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    while (events.length < count + 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
      }
    }
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
  // Drop the handshake frame so callers can assert on the business events.
  return events.slice(1);
}

describe('GET /api/stream', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await ctx.app.request('/api/stream');
    expect(res.status).toBe(401);
  });

  it('delivers events from any of the user\'s agents', async () => {
    // Seed two agents for the same user and open a single /api/stream.
    // Both events must reach the handler because fan-out is keyed on
    // userId, not agentId.
    const user = await ensureUser(ctx.testDb.db, PRIVY_DID);
    const [a1] = await ctx.testDb.db
      .insert(agents)
      .values({
        userId: user.id,
        name: 'A1',
        walletPubkey: 'So11111111111111111111111111111111111111112',
        framework: 'custom',
        agentType: 'other',
        ingestToken: 'tok-a1',
      })
      .returning({ id: agents.id });
    const [a2] = await ctx.testDb.db
      .insert(agents)
      .values({
        userId: user.id,
        name: 'A2',
        walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        framework: 'custom',
        agentType: 'other',
        ingestToken: 'tok-a2',
      })
      .returning({ id: agents.id });

    const events = await collectEvents(ctx.app, 2, () => {
      ctx.bus.publish({
        type: 'tx.new',
        agentId: a1!.id,
        userId: user.id,
        signature: 'sig-1',
        at: new Date().toISOString(),
      });
      ctx.bus.publish({
        type: 'tx.new',
        agentId: a2!.id,
        userId: user.id,
        signature: 'sig-2',
        at: new Date().toISOString(),
      });
    });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.agentId).sort()).toEqual([a1!.id, a2!.id].sort());
  });

  it("picks up a newly-created agent without reconnect", async () => {
    // Open the stream with zero agents for this user, then insert a
    // fresh agent row and publish an event for it. The global bus
    // subscription is keyed on userId, so the event reaches the
    // handler even though the agent did not exist at subscribe time.
    const user = await ensureUser(ctx.testDb.db, PRIVY_DID);

    const events = await collectEvents(ctx.app, 1, async () => {
      const [fresh] = await ctx.testDb.db
        .insert(agents)
        .values({
          userId: user.id,
          name: 'Fresh',
          walletPubkey: 'StakeSSzfxn391k3LvdKbZP5WVwWd6AsY1DNiXHjQfK',
          framework: 'custom',
          agentType: 'other',
          ingestToken: 'tok-fresh',
        })
        .returning({ id: agents.id });
      ctx.bus.publish({
        type: 'tx.new',
        agentId: fresh!.id,
        userId: user.id,
        signature: 'sig-late',
        at: new Date().toISOString(),
      });
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('tx.new');
    expect(events[0]?.signature).toBe('sig-late');
  });

  it("does not deliver another user's events", async () => {
    const aliceUser = await ensureUser(ctx.testDb.db, PRIVY_DID);
    const bobUser = await ensureUser(ctx.testDb.db, 'did:privy:user-bob');

    // Bob opens his own stream on a fresh app instance; Alice publishes.
    // Bob's subscriber must not see the event.
    const bobApp = buildApp({
      db: ctx.testDb.db,
      verifier: makeVerifier('did:privy:user-bob'),
      sseBus: ctx.bus,
      logger: silentLogger,
    });

    const controller = new AbortController();
    const res = await bobApp.request('/api/stream', {
      headers: { Authorization: BEARER },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Consume the handshake so the subscription is definitely active
    // before we publish Alice's event.
    await reader.read();

    ctx.bus.publish({
      type: 'tx.new',
      agentId: 'alice-agent',
      userId: aliceUser.id,
      signature: 'alice-sig',
      at: new Date().toISOString(),
    });

    // Give the event loop a chance to deliver (none should arrive).
    // Cap the wait tightly — if 100ms elapses without a frame, the
    // subscription correctly ignored Alice's publish.
    const raceResult = await Promise.race([
      reader.read().then((r) => ({ got: r, timeout: false })),
      new Promise<{ got: null; timeout: true }>((resolve) =>
        setTimeout(() => resolve({ got: null, timeout: true }), 100),
      ),
    ]);

    controller.abort();

    if (raceResult.timeout) {
      // Expected — no frame arrived.
      expect(true).toBe(true);
      return;
    }

    // If a frame did arrive, it had better not be Alice's tx.
    const chunk = decoder.decode(raceResult.got!.value);
    expect(chunk).not.toContain('alice-sig');
    // Reference bobUser to quiet the unused-variable lint without
    // weakening the assertion above.
    expect(bobUser.id).not.toBe(aliceUser.id);
  });
});
