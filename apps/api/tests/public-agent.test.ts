/**
 * Integration tests for public demo agent endpoints (C.0b).
 *
 * GET /public/demo
 * GET /public/agents/:id/overview
 * GET /public/agents/:id/transactions
 * GET /public/agents/:id/alerts
 *
 * All routes are unauthenticated; only the configured demoAgentId is served.
 */

import { agentTransactions, agents, alerts, reasoningLogs, users } from '@agentscope/db';
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

const OTHER_AGENT_ID = '22222222-2222-2222-2222-222222222222';

interface Ctx {
  app: ReturnType<typeof buildApp>;
  appNoDemoId: ReturnType<typeof buildApp>;
  testDb: TestDatabase;
  demoAgentDbId: string;
}

async function seedDemoAgent(db: TestDatabase['db']): Promise<string> {
  const [userRow] = await db
    .insert(users)
    .values({ privyDid: 'did:privy:demo-owner' })
    .returning({ id: users.id });
  const userId = userRow?.id;
  if (!userId) throw new Error('user insert failed');

  const [agentRow] = await db
    .insert(agents)
    .values({
      userId,
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'PriceWatcher',
      framework: 'elizaos',
      agentType: 'trader',
      ingestToken: 'tok_demo_secret',
      telegramChatId: '999888777',
      webhookUrl: 'https://secret.example.com/webhook',
      status: 'live',
    })
    .returning({ id: agents.id });
  const agentId = agentRow?.id;
  if (!agentId) throw new Error('agent insert failed');
  return agentId;
}

describe('Public demo agent endpoints (C.0b)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    const testDb = await createTestDatabase();
    const demoAgentDbId = await seedDemoAgent(testDb.db);

    const sseBus = createSseBus();
    ctx = {
      app: buildApp({
        db: testDb.db,
        verifier: STUB_VERIFIER,
        sseBus,
        logger: silentLogger,
        publicDemoAgentId: demoAgentDbId,
      }),
      appNoDemoId: buildApp({
        db: testDb.db,
        verifier: STUB_VERIFIER,
        sseBus,
        logger: silentLogger,
        // no publicDemoAgentId → demo disabled
      }),
      testDb,
      demoAgentDbId,
    };
  });

  afterEach(async () => {
    await ctx.testDb.close();
  });

  // --- GET /public/demo ---

  describe('GET /public/demo', () => {
    it('returns 404 when PUBLIC_DEMO_AGENT_ID is not configured', async () => {
      const res = await ctx.appNoDemoId.request('/public/demo');
      expect(res.status).toBe(404);
    });

    it('returns {agentId} when configured', async () => {
      const res = await ctx.app.request('/public/demo');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agentId: string };
      expect(body.agentId).toBe(ctx.demoAgentDbId);
    });

    it('is accessible without Authorization header', async () => {
      const res = await ctx.app.request('/public/demo', { headers: {} });
      expect(res.status).toBe(200);
    });
  });

  // --- GET /public/agents/:id/overview ---

  describe('GET /public/agents/:id/overview', () => {
    it('returns 404 for a non-demo agent id', async () => {
      const res = await ctx.app.request(`/public/agents/${OTHER_AGENT_ID}/overview`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a well-formed UUID that is not configured demo', async () => {
      const res = await ctx.appNoDemoId.request(`/public/agents/${ctx.demoAgentDbId}/overview`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a non-UUID id', async () => {
      const res = await ctx.app.request('/public/agents/not-a-uuid/overview');
      expect(res.status).toBe(404);
    });

    it('returns sanitized agent data — no sensitive fields', async () => {
      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/overview`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agent: Record<string, unknown> };
      expect(body.agent.id).toBe(ctx.demoAgentDbId);
      expect(body.agent.name).toBe('PriceWatcher');
      // sensitive fields must be absent
      expect(body.agent.ingestToken).toBeUndefined();
      expect(body.agent.telegramChatId).toBeUndefined();
      expect(body.agent.webhookUrl).toBeUndefined();
      expect(body.agent.userId).toBeUndefined();
    });

    it('returns KPI fields (recentTxCount, solDelta24h, successRate24h, lastAlert)', async () => {
      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/overview`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.recentTxCount).toBe('number');
      expect(typeof body.solDelta24h).toBe('string');
      expect(body.lastAlert).toBeNull();
    });

    it('is accessible without Authorization header', async () => {
      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/overview`, {
        headers: {},
      });
      expect(res.status).toBe(200);
    });
  });

  // --- GET /public/agents/:id/transactions ---

  describe('GET /public/agents/:id/transactions', () => {
    it('returns 404 for a non-demo agent id', async () => {
      const res = await ctx.app.request(`/public/agents/${OTHER_AGENT_ID}/transactions`);
      expect(res.status).toBe(404);
    });

    it('returns empty list when agent has no transactions', async () => {
      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/transactions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transactions: unknown[]; nextCursor: null };
      expect(body.transactions).toHaveLength(0);
      expect(body.nextCursor).toBeNull();
    });

    it('returns transactions and paginates with cursor', async () => {
      // insert 3 transactions
      for (let i = 0; i < 3; i++) {
        await ctx.testDb.db.insert(agentTransactions).values({
          agentId: ctx.demoAgentDbId,
          signature: `sig_pub_${i}`,
          slot: i,
          blockTime: new Date(Date.now() - i * 1000).toISOString(),
          programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
          success: true,
          feeLamports: 5000,
          solDelta: '0',
        });
      }

      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/transactions?limit=2`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transactions: unknown[]; nextCursor: string | null };
      expect(body.transactions).toHaveLength(2);
      expect(body.nextCursor).not.toBeNull();
    });

    it('strips parsedArgs and rawLogs from tx rows', async () => {
      await ctx.testDb.db.insert(agentTransactions).values({
        agentId: ctx.demoAgentDbId,
        signature: 'sig_pub_strip',
        slot: 99,
        blockTime: new Date().toISOString(),
        programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        success: true,
        feeLamports: 5000,
        solDelta: '0',
        parsedArgs: { inputMint: 'So11' },
        rawLogs: ['log line 1'],
      });

      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/transactions`);
      const body = (await res.json()) as { transactions: Record<string, unknown>[] };
      const tx = body.transactions[0];
      expect(tx).toBeDefined();
      expect(tx?.parsedArgs).toBeUndefined();
      expect(tx?.rawLogs).toBeUndefined();
    });
  });

  // --- GET /public/agents/:id/transactions/:signature/spans ---

  describe('GET /public/agents/:id/transactions/:signature/spans', () => {
    it('returns empty spans array when no reasoning logs exist for that signature', async () => {
      const res = await ctx.app.request(
        `/public/agents/${ctx.demoAgentDbId}/transactions/unknownsig/spans`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { spans: unknown[] };
      expect(body.spans).toHaveLength(0);
    });

    it('returns spans ordered by startTime for a matching signature', async () => {
      const sig = 'sig_spans_test_001';
      const traceId = 'a'.repeat(32);
      const now = new Date();

      await ctx.testDb.db.insert(agentTransactions).values({
        agentId: ctx.demoAgentDbId,
        signature: sig,
        slot: 1,
        blockTime: now.toISOString(),
        programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
        success: true,
        feeLamports: 5000,
        solDelta: '-0.01',
      });

      await ctx.testDb.db.insert(reasoningLogs).values([
        {
          agentId: ctx.demoAgentDbId,
          traceId,
          spanId: 'span0001',
          parentSpanId: null,
          spanName: 'price_oracle_check',
          startTime: new Date(now.getTime() - 3000).toISOString(),
          endTime: new Date(now.getTime() - 2000).toISOString(),
          attributes: { 'sol.price_usd': 150 },
          txSignature: sig,
        },
        {
          agentId: ctx.demoAgentDbId,
          traceId,
          spanId: 'span0002',
          parentSpanId: 'span0001',
          spanName: 'swap_execution_decision',
          startTime: new Date(now.getTime() - 1000).toISOString(),
          endTime: now.toISOString(),
          attributes: { decision: 'execute_swap' },
          txSignature: sig,
        },
      ]);

      const res = await ctx.app.request(
        `/public/agents/${ctx.demoAgentDbId}/transactions/${sig}/spans`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        spans: { spanName: string; parentSpanId: string | null }[];
      };
      expect(body.spans).toHaveLength(2);
      expect(body.spans[0]?.spanName).toBe('price_oracle_check');
      expect(body.spans[0]?.parentSpanId).toBeNull();
      expect(body.spans[1]?.spanName).toBe('swap_execution_decision');
    });

    it('returns 404 for a non-demo agent id', async () => {
      const res = await ctx.app.request(
        `/public/agents/${OTHER_AGENT_ID}/transactions/somesig/spans`,
      );
      expect(res.status).toBe(404);
    });
  });

  // --- GET /public/agents/:id/alerts ---

  describe('GET /public/agents/:id/alerts', () => {
    it('returns 404 for a non-demo agent id', async () => {
      const res = await ctx.app.request(`/public/agents/${OTHER_AGENT_ID}/alerts`);
      expect(res.status).toBe(404);
    });

    it('returns empty list when no alerts exist', async () => {
      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/alerts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { alerts: unknown[] };
      expect(body.alerts).toHaveLength(0);
    });

    it('returns alerts ordered newest first', async () => {
      for (let i = 0; i < 2; i++) {
        await ctx.testDb.db.insert(alerts).values({
          agentId: ctx.demoAgentDbId,
          ruleName: 'slippage_spike',
          severity: 'warning',
          payload: { slippagePct: 5 + i },
          triggeredAt: new Date(Date.now() - i * 60_000).toISOString(),
          dedupeKey: `slip:sig_${i}`,
        });
      }

      const res = await ctx.app.request(`/public/agents/${ctx.demoAgentDbId}/alerts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { alerts: { triggeredAt: string }[] };
      expect(body.alerts).toHaveLength(2);
      // newest first
      const first = body.alerts[0];
      const second = body.alerts[1];
      if (!first || !second) throw new Error('expected 2 alerts');
      expect(new Date(first.triggeredAt).getTime()).toBeGreaterThan(
        new Date(second.triggeredAt).getTime(),
      );
    });
  });
});
