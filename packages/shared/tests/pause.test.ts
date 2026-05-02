import { describe, expect, it } from 'vitest';
import { PAUSE_FOREVER, isAlertsPaused, isPausedForever } from '../src/pause';

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
