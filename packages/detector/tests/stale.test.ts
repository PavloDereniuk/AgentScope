/**
 * Integration tests for stale_agent rule (task 5.8).
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staleRule } from '../src/rules/stale';
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
let activeAgentId: string;
let dormantAgentId: string;

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:stale-test' })
    .returning();
  if (!user) throw new Error('seed user failed');

  // Agent with recent activity (10 min ago)
  const [active] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Active Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_stale_active',
    })
    .returning();
  if (!active) throw new Error('seed active agent failed');
  activeAgentId = active.id;

  await testDb.db.insert(agentTransactions).values({
    agentId: active.id,
    signature: 'sig_stale_recent',
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T11:50:00Z', // 10 min ago from "now"
  });

  // Agent with no transactions at all
  const [dormant] = await testDb.db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '22222222222222222222222222222222',
      name: 'Dormant Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_stale_dormant',
    })
    .returning();
  if (!dormant) throw new Error('seed dormant agent failed');
  dormantAgentId = dormant.id;
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(
  agentIdOverride: string,
  overrides: { staleMinutesThreshold?: number } = {},
): CronRuleContext {
  return {
    agent: {
      id: agentIdOverride,
      alertRules: overrides.staleMinutesThreshold
        ? { staleMinutesThreshold: overrides.staleMinutesThreshold }
        : {},
    },
    defaults,
    db: testDb.db,
    now: new Date('2026-04-09T12:00:00Z'),
  };
}

describe('stale_agent rule', () => {
  it('does not fire when last tx is within threshold (10 min < 30 min default)', async () => {
    const result = await staleRule.evaluate(makeCtx(activeAgentId));
    expect(result).toBeNull();
  });

  it('fires when last tx exceeds per-agent threshold', async () => {
    // 10 min inactive, threshold 5 min → fires
    const result = await staleRule.evaluate(makeCtx(activeAgentId, { staleMinutesThreshold: 5 }));
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('stale_agent');
    expect(result?.payload).toMatchObject({ thresholdMinutes: 5 });
  });

  it('fires info for agent with no transactions ever', async () => {
    const result = await staleRule.evaluate(makeCtx(dormantAgentId));
    expect(result).not.toBeNull();
    expect(result?.severity).toBe('info');
    expect(result?.payload).toMatchObject({ reason: 'no transactions ever' });
  });

  it('escalates to critical when idle time exceeds 3× threshold', async () => {
    // 10 min inactive, threshold 2 min → 5× threshold → critical
    const result = await staleRule.evaluate(makeCtx(activeAgentId, { staleMinutesThreshold: 2 }));
    expect(result?.severity).toBe('critical');
  });
});
