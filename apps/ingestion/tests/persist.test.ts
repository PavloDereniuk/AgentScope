/**
 * Tests for the rawLogs persistence cap (E.2 — storage diet).
 *
 * Pure-helper coverage for capRawLogs: slim slice on success, fuller slice
 * on failure, head/tail preservation, and the truncation marker. No DB —
 * the helper is side-effect free.
 */

import { describe, expect, it } from 'vitest';
import { RAW_LOGS_LIMIT_FAILURE, RAW_LOGS_LIMIT_SUCCESS, capRawLogs } from '../src/persist';

const makeLogs = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i}`);

describe('capRawLogs (E.2)', () => {
  it('returns logs unchanged when at or below the success limit', () => {
    const logs = makeLogs(RAW_LOGS_LIMIT_SUCCESS);
    const out = capRawLogs(logs, true);
    expect(out).toEqual(logs);
  });

  it('returns a fresh array (does not alias the input)', () => {
    const logs = makeLogs(5);
    const out = capRawLogs(logs, true);
    expect(out).not.toBe(logs);
    expect(out).toEqual(logs);
  });

  it('truncates a long success tx to the slim limit + marker', () => {
    const logs = makeLogs(1000);
    const out = capRawLogs(logs, true);
    const half = Math.floor(RAW_LOGS_LIMIT_SUCCESS / 2);
    // head + marker + tail
    expect(out).toHaveLength(half * 2 + 1);
    expect(out[half]).toBe(`…truncated ${1000 - RAW_LOGS_LIMIT_SUCCESS} lines…`);
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 999');
  });

  it('keeps a much larger slice on failure than on success', () => {
    const logs = makeLogs(1000);
    const onSuccess = capRawLogs(logs, true);
    const onFailure = capRawLogs(logs, false);
    expect(onFailure.length).toBeGreaterThan(onSuccess.length);
    const half = Math.floor(RAW_LOGS_LIMIT_FAILURE / 2);
    expect(onFailure).toHaveLength(half * 2 + 1);
    expect(onFailure[half]).toBe(`…truncated ${1000 - RAW_LOGS_LIMIT_FAILURE} lines…`);
  });

  it('preserves head and tail (boundary lines survive truncation)', () => {
    const logs = makeLogs(500);
    const out = capRawLogs(logs, false);
    expect(out[0]).toBe('line 0');
    expect(out[out.length - 1]).toBe('line 499');
  });

  it('does not truncate a failed tx that fits within the failure limit', () => {
    const logs = makeLogs(RAW_LOGS_LIMIT_FAILURE);
    const out = capRawLogs(logs, false);
    expect(out).toEqual(logs);
    expect(out.some((l) => l.includes('truncated'))).toBe(false);
  });

  it('handles an empty log array', () => {
    expect(capRawLogs([], true)).toEqual([]);
    expect(capRawLogs([], false)).toEqual([]);
  });

  it('slims a success tx that a failure tx would have kept in full', () => {
    // A log between the two limits: kept whole on failure, truncated on success.
    const logs = makeLogs(RAW_LOGS_LIMIT_FAILURE);
    expect(capRawLogs(logs, false)).toHaveLength(RAW_LOGS_LIMIT_FAILURE);
    expect(capRawLogs(logs, true).length).toBeLessThan(RAW_LOGS_LIMIT_FAILURE);
  });
});
