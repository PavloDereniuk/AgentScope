/**
 * Unit tests for the rule evaluator (task 5.2).
 *
 * These tests use in-memory stubs — no database, no real rules.
 * They verify the evaluator's iteration, result collection, and
 * error isolation logic.
 */

import type { Database } from '@agentscope/db';
import { describe, expect, it, vi } from 'vitest';
import { evaluateCron, evaluateTx } from '../src/evaluate';
import type { CronRuleContext, CronRuleDef, TxRuleContext, TxRuleDef } from '../src/types';

const stubDb = {} as Database;

const defaultThresholds = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

const baseAgent = { id: 'agent-1', alertRules: {} };

function makeTxCtx(overrides: Partial<TxRuleContext> = {}): TxRuleContext {
  return {
    agent: baseAgent,
    defaults: defaultThresholds,
    db: stubDb,
    now: new Date('2026-04-09T12:00:00Z'),
    transaction: {
      signature: 'sig123',
      instructionName: 'jupiter.swap',
      parsedArgs: {},
      solDelta: '-0.5',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    },
    ...overrides,
  };
}

function makeCronCtx(overrides: Partial<CronRuleContext> = {}): CronRuleContext {
  return {
    agent: baseAgent,
    defaults: defaultThresholds,
    db: stubDb,
    now: new Date('2026-04-09T12:00:00Z'),
    ...overrides,
  };
}

describe('evaluateTx', () => {
  it('returns empty array with zero rules', async () => {
    const results = await evaluateTx([], makeTxCtx());
    expect(results).toEqual([]);
  });

  it('collects results from rules that fire', async () => {
    const rule: TxRuleDef = {
      name: 'slippage_spike',
      evaluate: async () => ({
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: { actualPct: 12 },
      }),
    };

    const results = await evaluateTx([rule], makeTxCtx());
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleName).toBe('slippage_spike');
  });

  it('skips rules that return null', async () => {
    const fires: TxRuleDef = {
      name: 'slippage_spike',
      evaluate: async () => ({
        ruleName: 'slippage_spike',
        severity: 'warning',
        payload: {},
      }),
    };
    const skips: TxRuleDef = {
      name: 'gas_spike',
      evaluate: async () => null,
    };

    const results = await evaluateTx([fires, skips], makeTxCtx());
    expect(results).toHaveLength(1);
    expect(results[0]?.ruleName).toBe('slippage_spike');
  });

  it('catches and logs errors without stopping other rules', async () => {
    const broken: TxRuleDef = {
      name: 'slippage_spike',
      evaluate: async () => {
        throw new Error('boom');
      },
    };
    const healthy: TxRuleDef = {
      name: 'gas_spike',
      evaluate: async () => ({
        ruleName: 'gas_spike',
        severity: 'critical',
        payload: {},
      }),
    };

    const logger = { error: vi.fn() };
    const results = await evaluateTx([broken, healthy], makeTxCtx(), logger);

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleName).toBe('gas_spike');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ rule: 'slippage_spike' });
  });
});

describe('evaluateCron', () => {
  it('returns empty array with zero rules', async () => {
    const results = await evaluateCron([], makeCronCtx());
    expect(results).toEqual([]);
  });

  it('collects results from cron rules that fire', async () => {
    const rule: CronRuleDef = {
      name: 'stale_agent',
      evaluate: async () => ({
        ruleName: 'stale_agent',
        severity: 'warning',
        payload: { inactiveMinutes: 45 },
      }),
    };

    const results = await evaluateCron([rule], makeCronCtx());
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({ inactiveMinutes: 45 });
  });

  it('isolates errors across cron rules', async () => {
    const broken: CronRuleDef = {
      name: 'drawdown',
      evaluate: async () => {
        throw new Error('db timeout');
      },
    };
    const healthy: CronRuleDef = {
      name: 'stale_agent',
      evaluate: async () => ({
        ruleName: 'stale_agent',
        severity: 'info',
        payload: {},
      }),
    };

    const logger = { error: vi.fn() };
    const results = await evaluateCron([broken, healthy], makeCronCtx(), logger);

    expect(results).toHaveLength(1);
    expect(results[0]?.ruleName).toBe('stale_agent');
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
