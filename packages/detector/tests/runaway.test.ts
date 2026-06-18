/**
 * Integration tests for tx_rate_anomaly rule (post-MVP roadmap A.3, v0.4.2).
 *
 * Uses the same PGlite test-db pattern as error_rate — runs all real
 * migrations against an in-memory Postgres, seeds tx rows with controlled
 * timestamps, then asserts the rule's count + severity logic against the
 * 5-minute sliding window.
 *
 * Critical distinction from error_rate: this rule counts BOTH successful
 * and failed transactions, because a stuck retry loop burns priority fees
 * regardless of confirmation status. That is the failure mode the rule
 * catches (zacycled LLM decisions, retry-on-error storms).
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runawayRule } from '../src/rules/runaway';
import type { CronRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
  lowBalanceSol: 0.005,
  // 30 tx/min default ⇒ a 5-min window must hold ≤150 tx before the rule fires.
  txRateMaxPerMin: 30,
  priorityFeeMult: 10,
};

let testDb: TestDatabase;
/** Agent A: 200 tx in the 5-min window → 40 tx/min → above 30/min default. */
let runawayAgentId: string;
/** Agent B: 5 tx in window → 1 tx/min → healthy. */
let calmAgentId: string;
/** Agent C: 400 tx in window → 80 tx/min → 2.67× default → critical. */
let criticalAgentId: string;
/** Agent D: zero tx in window → no signal. */
let idleAgentId: string;
/** Agent E: 10 tx but all OUTSIDE the 5-min window → must be ignored. */
let staleWindowAgentId: string;
/** Agent F: 100 tx (50 success + 50 failed) → 20 tx/min combined.
 *  At low override threshold (10/min) this proves we count failures too,
 *  not just confirmed swaps like `error_rate` does. */
let mixedSuccessAgentId: string;

const NOW = new Date('2026-04-09T12:00:00Z');

/**
 * Stamp a tx at `secondsAgo` seconds before NOW. Keeps every test row's
 * `block_time` deterministic relative to `NOW` so the 5-min window math
 * is reproducible without mocking the clock.
 */
function isoSecondsAgo(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:runaway-test' })
    .returning();
  if (!user) throw new Error('seed user failed');
  // Local copy is needed so TS narrows the type inside the nested
  // `makeAgent` closure — `user` itself is `User | undefined` at the
  // closure boundary, even after the if-throw guard above.
  const userId = user.id;

  // Each agent needs a unique (user_id, wallet_pubkey) pair — the
  // agents_user_wallet_unique index on the `agents` table forbids reusing
  // the same wallet under one user. Six distinct 32-char base58 strings
  // is the minimum to seed all the rule scenarios in this file.
  async function makeAgent(name: string, token: string, wallet: string): Promise<string> {
    const [a] = await testDb.db
      .insert(agents)
      .values({
        userId,
        walletPubkey: wallet,
        name,
        framework: 'custom',
        agentType: 'other',
        ingestToken: token,
      })
      .returning();
    if (!a) throw new Error(`seed agent ${name} failed`);
    return a.id;
  }

  runawayAgentId = await makeAgent('Runaway', 'tok_runaway', '21111111111111111111111111111111');
  calmAgentId = await makeAgent('Calm', 'tok_calm', '31111111111111111111111111111111');
  criticalAgentId = await makeAgent('Critical', 'tok_critical', '41111111111111111111111111111111');
  idleAgentId = await makeAgent('Idle', 'tok_idle', '51111111111111111111111111111111');
  staleWindowAgentId = await makeAgent(
    'Stale Window',
    'tok_stale_window',
    '61111111111111111111111111111111',
  );
  mixedSuccessAgentId = await makeAgent('Mixed', 'tok_mixed', '71111111111111111111111111111111');

  const baseTx = {
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
  };

  // Runaway: 200 tx evenly spread over the last 300s (5 min) → 40 tx/min.
  const runawayTxs = Array.from({ length: 200 }, (_, i) => ({
    ...baseTx,
    agentId: runawayAgentId,
    signature: `sig_runaway_${i}`,
    blockTime: isoSecondsAgo(Math.floor((i * 300) / 200)),
  }));

  // Calm: 5 tx in 5-min window → 1 tx/min.
  const calmTxs = Array.from({ length: 5 }, (_, i) => ({
    ...baseTx,
    agentId: calmAgentId,
    signature: `sig_calm_${i}`,
    blockTime: isoSecondsAgo(i * 60),
  }));

  // Critical: 400 tx in 5-min window → 80 tx/min → 80/30 = 2.67× → critical.
  const criticalTxs = Array.from({ length: 400 }, (_, i) => ({
    ...baseTx,
    agentId: criticalAgentId,
    signature: `sig_critical_${i}`,
    blockTime: isoSecondsAgo(Math.floor((i * 300) / 400)),
  }));

  // Stale-window: 10 tx all >5 min old (between 6 min and 15 min ago).
  // These must NOT appear in the 5-min count.
  const staleWindowTxs = Array.from({ length: 10 }, (_, i) => ({
    ...baseTx,
    agentId: staleWindowAgentId,
    signature: `sig_stale_window_${i}`,
    blockTime: isoSecondsAgo(360 + i * 60),
  }));

  // Mixed: 100 tx (50 success + 50 failed) over 5-min window → 20 tx/min combined.
  // With per-agent threshold override at 10/min this fires; proves we count
  // failures too (error_rate would only see 50 failures out of 100 → 50%).
  const mixedTxs = Array.from({ length: 100 }, (_, i) => ({
    ...baseTx,
    agentId: mixedSuccessAgentId,
    signature: `sig_mixed_${i}`,
    success: i % 2 === 0,
    blockTime: isoSecondsAgo(Math.floor((i * 300) / 100)),
  }));

  await testDb.db
    .insert(agentTransactions)
    .values([...runawayTxs, ...calmTxs, ...criticalTxs, ...staleWindowTxs, ...mixedTxs]);
  // Idle agent gets no tx rows on purpose.
});

afterAll(async () => {
  await testDb.close();
});

function makeCtx(agentId: string, txRateMaxPerMinThreshold?: number): CronRuleContext {
  return {
    agent: {
      id: agentId,
      // Use `!== undefined` (not truthy) so `0` is forwarded as an explicit
      // override — needed for the misconfig-guard test which sets 0 and
      // expects the rule to abstain rather than fall back to the default.
      alertRules: txRateMaxPerMinThreshold !== undefined ? { txRateMaxPerMinThreshold } : {},
    },
    defaults,
    db: testDb.db,
    now: NOW,
  };
}

describe('tx_rate_anomaly rule', () => {
  it('fires warning when tx rate exceeds default threshold (40/min > 30/min)', async () => {
    const result = await runawayRule.evaluate(makeCtx(runawayAgentId));
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('tx_rate_anomaly');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      txCount: 200,
      thresholdPerMin: 30,
      windowMinutes: 5,
    });
    // ratePerMin = 200 / 5 = 40
    expect(result?.payload.ratePerMin).toBeCloseTo(40, 1);
  });

  it('does not fire when rate is below threshold (1/min ≪ 30/min)', async () => {
    const result = await runawayRule.evaluate(makeCtx(calmAgentId));
    expect(result).toBeNull();
  });

  it('does not fire when rate exactly equals threshold (strict-greater gate)', async () => {
    // Calm agent has 5 tx → rate 1/min. With threshold raised to exactly 1
    // the rule must NOT fire — otherwise borderline-healthy agents would
    // alert on every tick.
    const result = await runawayRule.evaluate(makeCtx(calmAgentId, 1));
    expect(result).toBeNull();
  });

  it('escalates to critical when rate ≥ 2× threshold (80/min vs 30/min → 2.67×)', async () => {
    const result = await runawayRule.evaluate(makeCtx(criticalAgentId));
    expect(result?.severity).toBe('critical');
    expect(result?.payload.ratePerMin).toBeCloseTo(80, 1);
  });

  it('abstains on idle agent (zero tx in window — no signal, not a runaway)', async () => {
    const result = await runawayRule.evaluate(makeCtx(idleAgentId));
    expect(result).toBeNull();
  });

  it('ignores transactions older than the 5-min window', async () => {
    // Stale-window agent has 10 tx all ≥ 6 min old. With threshold dropped
    // to a value that 10 tx would trip (10/5 = 2 tx/min, threshold 1) the
    // rule must still abstain — proving the window filter works.
    const result = await runawayRule.evaluate(makeCtx(staleWindowAgentId, 1));
    expect(result).toBeNull();
  });

  it('counts BOTH successful and failed tx (key distinction vs error_rate)', async () => {
    // Mixed agent: 100 tx (50 success + 50 failed) → 20 tx/min combined.
    // Override threshold to 10/min — only fires if we count all 100, not
    // just the 50 successes (50/5 = 10/min would NOT exceed 10 strictly).
    const result = await runawayRule.evaluate(makeCtx(mixedSuccessAgentId, 10));
    expect(result).not.toBeNull();
    expect(result?.payload).toMatchObject({ txCount: 100 });
    expect(result?.payload.ratePerMin).toBeCloseTo(20, 1);
  });

  it('honours per-agent threshold override', async () => {
    // Runaway agent (40/min) with per-agent threshold 50/min → must NOT fire.
    const result = await runawayRule.evaluate(makeCtx(runawayAgentId, 50));
    expect(result).toBeNull();
  });

  it('returns null when threshold is non-positive (misconfig guard)', async () => {
    // 0 would mean "any tx is a runaway" → alert storm. Guard returns null.
    const result = await runawayRule.evaluate(makeCtx(runawayAgentId, 0));
    expect(result).toBeNull();
  });

  it('emits a stable 5-min-bucket dedupe key within the window', async () => {
    // Use a low threshold (10/min) so the rule still fires after a small
    // forward shift in `now` — the seeded tx span only [NOW-300s, NOW],
    // so a 2-min shift drops some tx out of view and the effective rate
    // falls below the default 30/min. With 10/min both calls fire and we
    // can compare their dedupe keys.
    const noonCtx = makeCtx(runawayAgentId, 10);
    const twoMinLater: CronRuleContext = {
      ...noonCtx,
      now: new Date(NOW.getTime() + 2 * 60 * 1000),
    };
    const a = await runawayRule.evaluate(noonCtx);
    const b = await runawayRule.evaluate(twoMinLater);
    expect(a?.dedupeKey).toBeDefined();
    // 12:00 and 12:02 share the same 5-min bucket → same key
    // (one alert per intensity-window, not 5 per cycle).
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });

  it('emits a key that rotates across 5-min bucket boundaries', async () => {
    // Test the formula directly rather than seeding an active-for-10-min
    // agent: the rotation assertion is about WINDOW_MS being correct,
    // which is verifiable by computing the bucket index for two `now`
    // values that straddle a boundary. Decouples the test from how much
    // tx history happens to be seeded.
    const result = await runawayRule.evaluate(makeCtx(runawayAgentId, 10));
    expect(result?.dedupeKey).toBeDefined();
    const WINDOW_MS = 5 * 60 * 1000;
    const sameBucketKey = `tx_rate_anomaly:${runawayAgentId}:${Math.floor(NOW.getTime() / WINDOW_MS)}`;
    const nextBucketKey = `tx_rate_anomaly:${runawayAgentId}:${Math.floor((NOW.getTime() + WINDOW_MS) / WINDOW_MS)}`;
    expect(result?.dedupeKey).toBe(sameBucketKey);
    expect(sameBucketKey).not.toBe(nextBucketKey);
  });
});
