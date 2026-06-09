/**
 * Integration tests for GET /public/badge/:agentId (C.6 — README badge).
 *
 * Endpoint is unauthenticated — only the agent UUID is needed. Tests cover
 * the three status variants, cache headers, XML escaping, and 404 for
 * unknown / malformed IDs.
 */

import { agents, users } from '@agentscope/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';
import { createSseBus } from '../src/lib/sse-bus';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const silentLogger = pino({ level: 'silent' });

const STUB_VERIFIER = {
  async verify() {
    return { userId: 'did:privy:stub' };
  },
};

interface Ctx {
  app: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
}

async function seedAgent(
  db: TestDatabase['db'],
  opts: { status?: 'live' | 'stale' | 'failed'; name?: string } = {},
): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ privyDid: `did:privy:badge-test-${Math.random()}` })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (!userId) throw new Error('user insert failed');
  const agentRows = await db
    .insert(agents)
    .values({
      userId,
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: opts.name ?? 'Trade Bot',
      framework: 'elizaos',
      agentType: 'trader',
      ingestToken: `tok_badge_${Math.random().toString(36).slice(2)}`,
      status: opts.status ?? 'live',
    })
    .returning({ id: agents.id });
  const agentId = agentRows[0]?.id;
  if (!agentId) throw new Error('agent insert failed');
  return agentId;
}

describe('GET /public/badge/:agentId', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    const testDb = await createTestDatabase();
    ctx = {
      app: buildApp({
        db: testDb.db,
        verifier: STUB_VERIFIER,
        sseBus: createSseBus(),
        logger: silentLogger,
      }),
      testDb,
    };
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  it('returns 404 for a well-formed but unknown agentId', async () => {
    const res = await ctx.app.request('/public/badge/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-UUID agentId', async () => {
    const res = await ctx.app.request('/public/badge/not-a-uuid');
    expect(res.status).toBe(404);
  });

  it('returns 200 SVG for a live agent', async () => {
    const id = await seedAgent(ctx.testDb.db, { status: 'live', name: 'MyBot' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('MyBot');
    expect(svg).toContain('live');
    expect(svg).toContain('#4c1');
  });

  it('returns correct color for stale status', async () => {
    const id = await seedAgent(ctx.testDb.db, { status: 'stale' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('stale');
    expect(svg).toContain('#9f9f9f');
  });

  it('returns correct color for failed status', async () => {
    const id = await seedAgent(ctx.testDb.db, { status: 'failed' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('failed');
    expect(svg).toContain('#e05d44');
  });

  it('sets public cache headers', async () => {
    const id = await seedAgent(ctx.testDb.db, { status: 'live' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toContain('public');
    expect(cc).toContain('max-age');
  });

  it('is accessible without Authorization header', async () => {
    const id = await seedAgent(ctx.testDb.db, { status: 'live' });
    // Deliberately no auth header — public endpoint
    const res = await ctx.app.request(`/public/badge/${id}`, { headers: {} });
    expect(res.status).toBe(200);
  });

  it('XML-escapes HTML-special chars in agent name', async () => {
    const id = await seedAgent(ctx.testDb.db, { name: 'Bot <&> v2' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    const svg = await res.text();
    expect(svg).toContain('Bot &lt;&amp;&gt; v2');
    expect(svg).not.toContain('Bot <&> v2');
  });

  it('includes aria-label with both label and message', async () => {
    const id = await seedAgent(ctx.testDb.db, { name: 'AriaBot', status: 'live' });
    const res = await ctx.app.request(`/public/badge/${id}`);
    const svg = await res.text();
    expect(svg).toContain('aria-label="AriaBot: live"');
  });
});
