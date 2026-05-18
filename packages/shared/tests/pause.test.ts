import { describe, expect, it } from 'vitest';
import {
  PAUSE_FOREVER,
  isAlertsPaused,
  isPausedForever,
  isRulePaused,
  pickDeliveryAction,
} from '../src/pause';
import type { AlertRuleThresholds } from '../src/types';

const NOW = new Date('2026-05-01T12:00:00Z');

describe('isAlertsPaused', () => {
  it('returns false for null / undefined', () => {
    expect(isAlertsPaused(null, NOW)).toBe(false);
    expect(isAlertsPaused(undefined, NOW)).toBe(false);
  });

  it('returns false for past timestamps (auto-resume)', () => {
    expect(isAlertsPaused('2026-05-01T11:59:00Z', NOW)).toBe(false);
    expect(isAlertsPaused('2020-01-01T00:00:00Z', NOW)).toBe(false);
  });

  it('returns false for the exact `now` (strictly future required)', () => {
    expect(isAlertsPaused('2026-05-01T12:00:00Z', NOW)).toBe(false);
  });

  it('returns true for future timestamps', () => {
    expect(isAlertsPaused('2026-05-01T12:00:01Z', NOW)).toBe(true);
    expect(isAlertsPaused('2026-05-02T00:00:00Z', NOW)).toBe(true);
  });

  it('returns true for the PAUSE_FOREVER sentinel', () => {
    expect(isAlertsPaused(PAUSE_FOREVER, NOW)).toBe(true);
  });

  it('returns false for unparseable strings (defensive)', () => {
    expect(isAlertsPaused('not-a-date', NOW)).toBe(false);
    expect(isAlertsPaused('', NOW)).toBe(false);
  });
});

describe('isPausedForever', () => {
  it('returns false for null / undefined / empty', () => {
    expect(isPausedForever(null)).toBe(false);
    expect(isPausedForever(undefined)).toBe(false);
    expect(isPausedForever('')).toBe(false);
  });

  it('returns false for normal future dates', () => {
    expect(isPausedForever('2026-05-02T00:00:00Z')).toBe(false);
    expect(isPausedForever('2099-12-31T23:59:59Z')).toBe(false);
  });

  it('returns true for the PAUSE_FOREVER sentinel', () => {
    expect(isPausedForever(PAUSE_FOREVER)).toBe(true);
  });

  it('returns true for any date past the threshold year', () => {
    expect(isPausedForever('9000-01-01T00:00:00Z')).toBe(true);
    expect(isPausedForever('9999-12-31T23:59:59.999Z')).toBe(true);
  });
});

describe('isRulePaused', () => {
  it('returns false when the rule has no entry in pausedUntil', () => {
    // No pausedUntil map at all → not paused.
    expect(isRulePaused({}, 'slippage_spike', NOW)).toBe(false);
    // Map exists but no entry for this specific rule.
    const thresholds: AlertRuleThresholds = {
      pausedUntil: { drawdown: '2026-06-01T00:00:00Z' },
    };
    expect(isRulePaused(thresholds, 'slippage_spike', NOW)).toBe(false);
    // Null / undefined thresholds (legacy rows).
    expect(isRulePaused(null, 'slippage_spike', NOW)).toBe(false);
    expect(isRulePaused(undefined, 'slippage_spike', NOW)).toBe(false);
  });

  it('returns true when the rule entry is strictly in the future', () => {
    const thresholds: AlertRuleThresholds = {
      pausedUntil: {
        slippage_spike: '2026-05-01T12:00:01Z',
        drawdown: PAUSE_FOREVER,
      },
    };
    expect(isRulePaused(thresholds, 'slippage_spike', NOW)).toBe(true);
    expect(isRulePaused(thresholds, 'drawdown', NOW)).toBe(true);
  });

  it('returns false when the rule entry is in the past (auto-resume)', () => {
    const thresholds: AlertRuleThresholds = {
      pausedUntil: {
        slippage_spike: '2026-05-01T11:59:00Z',
        // Exact `now` is not "strictly future" — mirrors isAlertsPaused.
        gas_spike: '2026-05-01T12:00:00Z',
        stale_agent: '2020-01-01T00:00:00Z',
      },
    };
    expect(isRulePaused(thresholds, 'slippage_spike', NOW)).toBe(false);
    expect(isRulePaused(thresholds, 'gas_spike', NOW)).toBe(false);
    expect(isRulePaused(thresholds, 'stale_agent', NOW)).toBe(false);
  });
});

describe('pickDeliveryAction', () => {
  const FUTURE = '2026-06-01T00:00:00Z';
  const PAST = '2026-01-01T00:00:00Z';

  it('returns "deliver" when neither global nor per-rule pause is active', () => {
    expect(pickDeliveryAction({}, null, 'slippage_spike', NOW)).toBe('deliver');
    expect(
      pickDeliveryAction({ pausedUntil: { drawdown: FUTURE } }, null, 'slippage_spike', NOW),
    ).toBe('deliver');
    // Past timestamps auto-resume on both layers.
    expect(
      pickDeliveryAction({ pausedUntil: { slippage_spike: PAST } }, PAST, 'slippage_spike', NOW),
    ).toBe('deliver');
  });

  it('returns "skip-rule-paused" when only the per-rule entry is future', () => {
    const thresholds: AlertRuleThresholds = { pausedUntil: { slippage_spike: FUTURE } };
    expect(pickDeliveryAction(thresholds, null, 'slippage_spike', NOW)).toBe('skip-rule-paused');
    // Other rules in the same agent are unaffected.
    expect(pickDeliveryAction(thresholds, null, 'drawdown', NOW)).toBe('deliver');
  });

  it('returns "skip-paused" when only the agent-wide pause is active', () => {
    expect(pickDeliveryAction({}, FUTURE, 'slippage_spike', NOW)).toBe('skip-paused');
    expect(pickDeliveryAction(null, FUTURE, 'drawdown', NOW)).toBe('skip-paused');
  });

  it('returns "skip-paused" (not "skip-rule-paused") when both layers are active — global trumps', () => {
    const thresholds: AlertRuleThresholds = { pausedUntil: { slippage_spike: FUTURE } };
    expect(pickDeliveryAction(thresholds, FUTURE, 'slippage_spike', NOW)).toBe('skip-paused');
    // Global active even if the per-rule entry is in the past — global wins.
    const resumed: AlertRuleThresholds = { pausedUntil: { slippage_spike: PAST } };
    expect(pickDeliveryAction(resumed, FUTURE, 'slippage_spike', NOW)).toBe('skip-paused');
  });
});
