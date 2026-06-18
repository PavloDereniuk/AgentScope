/**
 * Tests for low_balance cron rule (post-MVP roadmap A.2, v0.4.1).
 *
 * Pure-unit: no Postgres, no chain. The rule reads balance through an
 * injected `BalanceFetcher` so we test it with stub fetchers that return
 * scripted values (or null, or throw) and assert severity + payload +
 * dedupe shape. Wiring to the real Helius RPC lives in the ingestion
 * package and has its own helper tests.
 */

import type { Database } from '@agentscope/db';
import { describe, expect, it, vi } from 'vitest';
import { lowBalanceRule } from '../src/rules/low-balance';
import type { BalanceFetcher, CronRuleContext } from '../src/types';

const stubDb = {} as Database;
const WALLET = 'AGZ1JN6mFV4hyTfBwGZc81H1J9hSHt4HZ8KuYpDJSk7H';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
  // 0.005 SOL warning → 0.001 SOL critical (one-fifth).
  lowBalanceSol: 0.005,
  txRateMaxPerMin: 30,
  priorityFeeMult: 10,
};

function makeCtx(overrides: {
  balance?: number | null;
  fetcherThrows?: boolean;
  agentThreshold?: number;
  walletPubkey?: string | undefined;
  fetcher?: BalanceFetcher;
}): CronRuleContext {
  const fetcher: BalanceFetcher | undefined =
    overrides.fetcher ??
    (overrides.fetcherThrows
      ? vi.fn().mockRejectedValue(new Error('rpc down'))
      : overrides.balance !== undefined
        ? vi.fn().mockResolvedValue(overrides.balance)
        : undefined);

  return {
    agent: {
      id: 'agent-1',
      alertRules:
        overrides.agentThreshold !== undefined
          ? { lowBalanceSolThreshold: overrides.agentThreshold }
          : {},
      ...('walletPubkey' in overrides
        ? overrides.walletPubkey !== undefined
          ? { walletPubkey: overrides.walletPubkey }
          : {}
        : { walletPubkey: WALLET }),
    },
    defaults,
    db: stubDb,
    now: new Date('2026-04-09T12:00:00Z'),
    ...(fetcher ? { fetchAgentBalance: fetcher } : {}),
  };
}

describe('low_balance rule', () => {
  it('returns null when balance is healthy (above warning threshold)', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.5 }));
    expect(result).toBeNull();
  });

  it('returns null when balance equals threshold (strict-less gating)', async () => {
    // 0.005 is the warning threshold; balance == threshold must NOT fire.
    // Otherwise a freshly-topped wallet at exactly the floor would alert.
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.005 }));
    expect(result).toBeNull();
  });

  it('fires warning when balance is below threshold but above critical', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.003 }));
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('low_balance');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      balanceSol: 0.003,
      thresholdSol: 0.005,
      criticalThresholdSol: 0.001,
    });
  });

  it('escalates to critical when balance is below criticalThreshold (threshold / 5)', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.0005 }));
    expect(result?.severity).toBe('critical');
  });

  it('uses per-agent threshold override when provided', async () => {
    // Per-agent 0.1 SOL threshold; balance 0.05 → below 0.1 but above 0.02 (0.1/5) → warning
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.05, agentThreshold: 0.1 }));
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({ thresholdSol: 0.1, criticalThresholdSol: 0.02 });
  });

  it('returns null when threshold is non-positive (misconfig guard)', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: 0.001, agentThreshold: 0 }));
    expect(result).toBeNull();
  });

  it('abstains when fetcher is unwired (e.g. tx-runner path)', async () => {
    // Build the ctx without passing a balance so `makeCtx` omits the
    // `fetchAgentBalance` field (mirrors the tx-runner / test-only path
    // where no balance lookup is wired up).
    const result = await lowBalanceRule.evaluate(makeCtx({}));
    expect(result).toBeNull();
  });

  it('abstains when walletPubkey is missing on the agent snapshot', async () => {
    const result = await lowBalanceRule.evaluate(
      makeCtx({ balance: 0.0001, walletPubkey: undefined }),
    );
    expect(result).toBeNull();
  });

  it('abstains when fetcher returns null (unknown balance)', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ balance: null }));
    expect(result).toBeNull();
  });

  it('abstains when fetcher throws (RPC failure must not surface as alert)', async () => {
    const result = await lowBalanceRule.evaluate(makeCtx({ fetcherThrows: true }));
    expect(result).toBeNull();
  });

  it('passes the agent walletPubkey to the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue(0.5);
    await lowBalanceRule.evaluate(makeCtx({ fetcher }));
    expect(fetcher).toHaveBeenCalledWith(WALLET);
  });

  it('emits a stable hourly dedupe key', async () => {
    // 12:00 and 12:30 same hour → identical key (one alert per hour, not 60 per cycle).
    const noonCtx = makeCtx({ balance: 0.0001 });
    const halfPastCtx: CronRuleContext = {
      ...noonCtx,
      now: new Date('2026-04-09T12:30:00Z'),
    };
    const a = await lowBalanceRule.evaluate(noonCtx);
    const b = await lowBalanceRule.evaluate(halfPastCtx);
    expect(a?.dedupeKey).toBeDefined();
    expect(a?.dedupeKey).toBe(b?.dedupeKey);
  });

  it('rotates dedupe key across hourly boundary', async () => {
    const noonCtx = makeCtx({ balance: 0.0001 });
    const oneHourLater: CronRuleContext = {
      ...noonCtx,
      now: new Date('2026-04-09T13:01:00Z'),
    };
    const a = await lowBalanceRule.evaluate(noonCtx);
    const b = await lowBalanceRule.evaluate(oneHourLater);
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });
});
