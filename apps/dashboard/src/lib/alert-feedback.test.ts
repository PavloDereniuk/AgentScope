import { describe, expect, it } from 'vitest';
import { nextFeedback, noiseRate } from './alert-feedback';

describe('nextFeedback', () => {
  it('sets a label on an unlabelled alert', () => {
    expect(nextFeedback(null, 'noise')).toBe('noise');
  });

  it('clears the label when the active button is clicked again', () => {
    expect(nextFeedback('useful', 'useful')).toBeNull();
  });

  it('switches to the other label', () => {
    expect(nextFeedback('useful', 'noise')).toBe('noise');
  });
});

describe('noiseRate', () => {
  it('is null without stats or without labels', () => {
    expect(noiseRate(undefined)).toBeNull();
    expect(noiseRate({ ruleName: 'gas_spike', total: 12, useful: 0, noise: 0 })).toBeNull();
  });

  it('ignores unlabelled alerts in the denominator', () => {
    expect(noiseRate({ ruleName: 'gas_spike', total: 40, useful: 1, noise: 3 })).toEqual({
      labelled: 4,
      pct: 75,
    });
  });

  it('rounds to a whole percent', () => {
    expect(noiseRate({ ruleName: 'drawdown', total: 3, useful: 2, noise: 1 })).toEqual({
      labelled: 3,
      pct: 33,
    });
  });
});
