import { PAUSE_FOREVER } from '@agentscope/shared';
import { describe, expect, it } from 'vitest';
import { formatPausedUntil, humanizeMs } from './format-paused';

const NOW = new Date('2026-05-18T12:00:00.000Z');

describe('formatPausedUntil', () => {
  it('returns empty string for null / undefined / unparseable input', () => {
    expect(formatPausedUntil(null, NOW)).toBe('');
    expect(formatPausedUntil(undefined, NOW)).toBe('');
    expect(formatPausedUntil('not-a-date', NOW)).toBe('');
    expect(formatPausedUntil('', NOW)).toBe('');
  });

  it('returns empty string for timestamps in the past (auto-resume — caller hides)', () => {
    expect(formatPausedUntil('2026-05-18T11:59:00.000Z', NOW)).toBe('');
    expect(formatPausedUntil('2020-01-01T00:00:00.000Z', NOW)).toBe('');
    // Exact `now` is not "strictly future" — mirrors isAlertsPaused semantics.
    expect(formatPausedUntil('2026-05-18T12:00:00.000Z', NOW)).toBe('');
  });

  it('returns "indefinitely" for the PAUSE_FOREVER sentinel and any year ≥ 9000', () => {
    expect(formatPausedUntil(PAUSE_FOREVER, NOW)).toBe('indefinitely');
    expect(formatPausedUntil('9000-01-01T00:00:00.000Z', NOW)).toBe('indefinitely');
    expect(formatPausedUntil('9999-12-31T23:59:59.999Z', NOW)).toBe('indefinitely');
  });

  it('returns a compact relative duration for upcoming deadlines within 60 days', () => {
    // +30 minutes.
    expect(formatPausedUntil('2026-05-18T12:30:00.000Z', NOW)).toBe('30m');
    // +6 hours.
    expect(formatPausedUntil('2026-05-18T18:00:00.000Z', NOW)).toBe('6h');
    // +23h 12m.
    expect(formatPausedUntil('2026-05-19T11:12:00.000Z', NOW)).toBe('23h 12m');
    // +2d 4h.
    expect(formatPausedUntil('2026-05-20T16:00:00.000Z', NOW)).toBe('2d 4h');
    // Sub-minute → "<1m" so the badge never renders an empty label.
    expect(formatPausedUntil('2026-05-18T12:00:30.000Z', NOW)).toBe('<1m');
  });

  it('falls back to UTC absolute when the deadline is more than 60 days out', () => {
    // +90 days. Relative "90d" is technically valid but useless to humans —
    // we switch to an absolute UTC date so the user sees the actual day.
    expect(formatPausedUntil('2026-08-16T12:00:00.000Z', NOW)).toBe('Aug 16 2026, 12:00 UTC');
    // Just over the 60d boundary — confirms the cutoff direction.
    expect(formatPausedUntil('2026-07-18T12:00:01.000Z', NOW)).toBe('Jul 18 2026, 12:00 UTC');
  });
});

describe('humanizeMs', () => {
  it('returns "<1m" for sub-minute durations', () => {
    expect(humanizeMs(0)).toBe('<1m');
    expect(humanizeMs(59_999)).toBe('<1m');
  });

  it('formats hours-only and hours+minutes', () => {
    expect(humanizeMs(60 * 60 * 1000)).toBe('1h');
    expect(humanizeMs(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe('2h 30m');
  });

  it('formats days-only and days+hours, dropping the minutes term', () => {
    expect(humanizeMs(24 * 60 * 60 * 1000)).toBe('1d');
    expect(humanizeMs(24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000 + 17 * 60 * 1000)).toBe('1d 5h');
  });
});
