/**
 * Tests for ghost_execution rule (Epic 17).
 *
 * Cron rule. Seeds an agent with several EXECUTE_SWAP spans + a mix of
 * persisted/unpersisted txs and exercises the grace window, lookback,
 * dedupe, and severity escalation paths.
 */

import { agentTransactions, agents, reasoningLogs, users } from '@agentscope/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ghostExecutionRule } from '../src/rules/ghost-execution';
import type { CronRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

let testDb: TestDatabase;
let agentId: string;
let isolatedAgentId: string;

const SIG_GHOST_OLD =
  'sigghst000000000000000000000000000000000000000000000000000000000000000000000000';
const SIG_GHOST_NEW =
  'sigghst200000000000000000000000000000000000000000000000000000000000000000000000';
const SIG_PERSISTED =
  'sigprst000000000000000000000000000000000000000000000000000000000000000000000000';
const SIG_INFLIGHT =
  'siginfl000000000000000000000000000000000000000000000000000000000000000000000000';

const NOW = new Date('2026-04-09T12:00:00Z');

async function clearForAgent(id: string) {
  await testDb.db.delete(reasoningLogs).where(eq(reasoningLogs.agentId, id));
  await testDb.db.delete(agentTransactions).where(eq(agentTransactions.agentId, id));
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:ghost-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  const [primary] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Ghost Agent',
      framework: 'custom',
      agentType: 'trader',
      ingestToken: 'tok_ghost_1',
    })
    .returning();
  if (!primary) throw new Error('seed primary agent failed');
  agentId = primary.id;

  const [other] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '22222222222222222222222222222222',
      name: 'Other Agent',
      framework: 'custom',
      agentType: 'trader',
      ingestToken: 'tok_ghost_2',
    })
    .returning();
  if (!other) throw new Error('seed other agent failed');
  isolatedAgentId = other.id;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await clearForAgent(agentId);
  await clearForAgent(isolatedAgentId);
});

function makeCtx(overrides: { agentThreshold?: number } = {}): CronRuleContext {
  return {
    agent: {
      id: agentId,
      alertRules: overrides.agentThreshold
        ? { ghostExecutionMinutesThreshold: overrides.agentThreshold }
        : {},
    },
    defaults,
    db: testDb.db,
    now: NOW,
  };
}

async function seedSpan(args: {
  agentId: string;
  spanId: string;
  spanName?: string;
  txSignature: string | null;
  endMinutesAgo: number;
  attributes?: Record<string, unknown>;
}) {
  const end = new Date(NOW.getTime() - args.endMinutesAgo * 60_000).toISOString();
  await testDb.db.insert(reasoningLogs).values({
    agentId: args.agentId,
    traceId: args.spanId.repeat(2).slice(0, 32),
    spanId: args.spanId,
    parentSpanId: null,
    spanName: args.spanName ?? 'EXECUTE_SWAP',
    startTime: end,
    endTime: end,
    attributes: args.attributes ?? { 'action.name': 'EXECUTE_SWAP' },
    txSignature: args.txSignature,
  });
}

async function seedTx(signature: string) {
  await testDb.db.insert(agentTransactions).values({
    agentId,
    signature,
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T11:50:00Z',
  });
}

describe('ghost_execution rule', () => {
  it('fires warning for a single stuck swap span past the grace window', async () => {
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_GHOST_OLD,
      endMinutesAgo: 10,
    });

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      ghostCount: 1,
      oldestSignature: SIG_GHOST_OLD,
    });
    expect(result?.dedupeKey).toContain(SIG_GHOST_OLD);
  });

  it('escalates to critical when multiple ghosts exist', async () => {
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_GHOST_OLD,
      endMinutesAgo: 30,
    });
    await seedSpan({
      agentId,
      spanId: 'b'.repeat(16),
      txSignature: SIG_GHOST_NEW,
      endMinutesAgo: 10,
    });

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result?.severity).toBe('critical');
    expect(result?.payload).toMatchObject({ ghostCount: 2, oldestSignature: SIG_GHOST_OLD });
  });

  it('does not fire when matching tx is persisted', async () => {
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_PERSISTED,
      endMinutesAgo: 10,
    });
    await seedTx(SIG_PERSISTED);

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result).toBeNull();
  });

  it('does not fire for spans inside the grace window', async () => {
    // Default threshold = 5 min. A 2-min-old span is still in flight.
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_INFLIGHT,
      endMinutesAgo: 2,
    });

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result).toBeNull();
  });

  it('does not fire for non-swap spans even if tx_signature is set', async () => {
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      spanName: 'ANALYZE_MARKET',
      txSignature: SIG_GHOST_OLD,
      endMinutesAgo: 10,
      attributes: { 'reasoning.source': 'coingecko' },
    });

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result).toBeNull();
  });

  it('respects per-agent threshold override (suppresses 10-min-old at 30-min threshold)', async () => {
    await seedSpan({
      agentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_GHOST_OLD,
      endMinutesAgo: 10,
    });

    const result = await ghostExecutionRule.evaluate(makeCtx({ agentThreshold: 30 }));
    expect(result).toBeNull();
  });

  it('isolates per-agent: ignores other agents ghost spans', async () => {
    await seedSpan({
      agentId: isolatedAgentId,
      spanId: 'a'.repeat(16),
      txSignature: SIG_GHOST_OLD,
      endMinutesAgo: 10,
    });

    const result = await ghostExecutionRule.evaluate(makeCtx());
    expect(result).toBeNull();
  });
});
