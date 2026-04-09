/**
 * TDD tests for slippage_spike rule (tasks 5.3 + 5.4).
 *
 * The rule fires when a Jupiter swap's slippage tolerance (slippageBps
 * from parsedArgs) exceeds the configured threshold.
 */

import type { Database } from '@agentscope/db';
import { describe, expect, it } from 'vitest';
import { slippageRule } from '../src/rules/slippage';
import type { TxRuleContext } from '../src/types';

const stubDb = {} as Database;

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

function makeTxCtx(overrides: {
  instructionName?: string | null;
  parsedArgs?: Record<string, unknown> | null;
  agentThreshold?: number;
}): TxRuleContext {
  return {
    agent: {
      id: 'agent-1',
      alertRules: overrides.agentThreshold
        ? { slippagePctThreshold: overrides.agentThreshold }
        : {},
    },
    defaults,
    db: stubDb,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature: 'sig123',
      instructionName: overrides.instructionName ?? 'jupiter.swap',
      parsedArgs: overrides.parsedArgs ?? { slippageBps: 500 },
      solDelta: '-1.0',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    },
  };
}

describe('slippage_spike rule', () => {
  it('fires warning when slippageBps exceeds default threshold', async () => {
    // 1200 bps = 12%, default threshold = 5% → 2.4x → warning
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 1200 } });
    const result = await slippageRule.evaluate(ctx);

    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('slippage_spike');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      actualPct: 12,
      thresholdPct: 5,
    });
  });

  it('does not fire when slippage is within threshold', async () => {
    // 300 bps = 3%, default threshold = 5%
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 300 } });
    const result = await slippageRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('uses per-agent threshold override when set', async () => {
    // 800 bps = 8%, agent threshold = 10% → should NOT fire
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 800 }, agentThreshold: 10 });
    const result = await slippageRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('fires with per-agent threshold when exceeded', async () => {
    // 1200 bps = 12%, agent threshold = 10% → should fire
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 1200 }, agentThreshold: 10 });
    const result = await slippageRule.evaluate(ctx);
    expect(result).not.toBeNull();
    expect(result?.payload).toMatchObject({ thresholdPct: 10, actualPct: 12 });
  });

  it('skips non-Jupiter instructions', async () => {
    const ctx = makeTxCtx({ instructionName: 'kamino.deposit', parsedArgs: { slippageBps: 9999 } });
    const result = await slippageRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when parsedArgs is null', async () => {
    const ctx = makeTxCtx({ parsedArgs: null });
    const result = await slippageRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('skips when slippageBps is missing from parsedArgs', async () => {
    const ctx = makeTxCtx({ parsedArgs: { inAmount: 100 } });
    const result = await slippageRule.evaluate(ctx);
    expect(result).toBeNull();
  });

  it('fires critical when slippage exceeds 5x threshold', async () => {
    // 30000 bps = 300%, default threshold = 5% → 60x → critical
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 30000 } });
    const result = await slippageRule.evaluate(ctx);
    expect(result?.severity).toBe('critical');
  });

  it('includes signature in dedupeKey', async () => {
    const ctx = makeTxCtx({ parsedArgs: { slippageBps: 5000 } });
    const result = await slippageRule.evaluate(ctx);
    expect(result?.dedupeKey).toContain('sig123');
  });
});
