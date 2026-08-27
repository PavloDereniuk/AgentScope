/**
 * Tests for the self-kill watchdog.
 *
 * The verdict function is pure, so most of this file drives it directly with
 * fabricated marks. The timer path is exercised only for the things a pure
 * function cannot express: that it exits non-zero, and that it fires once.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  type WatchdogMarks,
  evaluateWatchdog,
  startWatchdog,
} from '../src/watchdog';

const START = Date.parse('2026-08-25T16:46:00.000Z');
const MIN = 60_000;

/** Marks for a worker that booted at START and is healthy as of `now`. */
function healthy(now: number): WatchdogMarks {
  return {
    startedAtMs: START,
    lastSlotAtMs: now - 1_000,
    lastCronTickAtMs: now - 30_000,
    lastWriteOkAtMs: now - 5_000,
  };
}

describe('evaluateWatchdog', () => {
  it('clears a worker whose signals are all fresh', () => {
    const now = START + 60 * MIN;
    expect(evaluateWatchdog(healthy(now), now)).toEqual({ wedged: false });
  });

  it('clears a freshly booted worker that has not produced a signal yet', () => {
    // Every mark is null three seconds in. Ageing from startedAt is what keeps
    // this from reading as three simultaneous stalls.
    const now = START + 3_000;
    const verdict = evaluateWatchdog(
      { startedAtMs: START, lastSlotAtMs: null, lastCronTickAtMs: null, lastWriteOkAtMs: null },
      now,
    );
    expect(verdict).toEqual({ wedged: false });
  });

  it('flags a dead subscription — mainnet produces a slot every ~400ms', () => {
    const now = START + 60 * MIN;
    const verdict = evaluateWatchdog({ ...healthy(now), lastSlotAtMs: now - 11 * MIN }, now);
    expect(verdict.wedged).toBe(true);
    expect(verdict.reason).toBe('stream-stalled');
    expect(verdict.ageSec).toBe(660);
  });

  it('flags the 2026-08-25 signature: a cron cycle that never completes', () => {
    const now = START + 60 * MIN;
    const verdict = evaluateWatchdog({ ...healthy(now), lastCronTickAtMs: now - 40 * MIN }, now);
    expect(verdict.wedged).toBe(true);
    expect(verdict.reason).toBe('cron-stalled');
  });

  it('flags a database path that stopped accepting writes', () => {
    const now = START + 60 * MIN;
    const verdict = evaluateWatchdog({ ...healthy(now), lastWriteOkAtMs: now - 20 * MIN }, now);
    expect(verdict.wedged).toBe(true);
    expect(verdict.reason).toBe('heartbeat-write-stalled');
  });

  it('never judges transaction age — an idle fleet is not an outage', () => {
    // lastTxAt is deliberately absent from WatchdogMarks. This test exists to
    // fail loudly if someone adds it: a quiet week would become a restart loop.
    const now = START + 30 * 24 * 60 * MIN;
    expect(evaluateWatchdog(healthy(now), now)).toEqual({ wedged: false });
  });

  it('reports the most specific reason when several signals are stale at once', () => {
    // A wedged network takes out the stream, the cron and the writes together.
    // Checks run narrowest-first so the operator gets the leading edge.
    const now = START + 60 * MIN;
    const verdict = evaluateWatchdog(
      {
        startedAtMs: START,
        lastSlotAtMs: now - 40 * MIN,
        lastCronTickAtMs: now - 40 * MIN,
        lastWriteOkAtMs: now - 40 * MIN,
      },
      now,
    );
    expect(verdict.reason).toBe('stream-stalled');
  });

  it('does not fire exactly at the threshold, only past it', () => {
    const now = START + 60 * MIN;
    const atLimit = { ...healthy(now), lastSlotAtMs: now - DEFAULT_THRESHOLDS.streamStalledMs };
    expect(evaluateWatchdog(atLimit, now).wedged).toBe(false);

    const pastLimit = {
      ...healthy(now),
      lastSlotAtMs: now - DEFAULT_THRESHOLDS.streamStalledMs - 1,
    };
    expect(evaluateWatchdog(pastLimit, now).wedged).toBe(true);
  });

  it('honours overridden thresholds', () => {
    const now = START + 60 * MIN;
    const marks = { ...healthy(now), lastSlotAtMs: now - 2 * MIN };
    expect(evaluateWatchdog(marks, now).wedged).toBe(false);
    expect(
      evaluateWatchdog(marks, now, { ...DEFAULT_THRESHOLDS, streamStalledMs: MIN }).wedged,
    ).toBe(true);
  });
});

describe('startWatchdog', () => {
  function harness(marks: WatchdogMarks, now: number) {
    const exits: number[] = [];
    const fatals: Array<Record<string, unknown> | string> = [];
    const wd = startWatchdog({
      logger: { fatal: (obj) => fatals.push(obj) },
      marks: () => marks,
      now: () => now,
      exit: (code) => exits.push(code),
    });
    return { wd, exits, fatals };
  }

  it('exits non-zero so ON_FAILURE brings a fresh container up', () => {
    // exit(0) would read as "the job finished" and nothing would restart.
    const now = START + 60 * MIN;
    const { wd, exits, fatals } = harness({ ...healthy(now), lastSlotAtMs: now - 40 * MIN }, now);

    wd.check();
    wd.stop();

    expect(exits).toEqual([1]);
    expect(fatals[0]).toMatchObject({ reason: 'stream-stalled' });
  });

  it('does not touch a healthy worker', () => {
    const now = START + 60 * MIN;
    const { wd, exits, fatals } = harness(healthy(now), now);

    wd.check();
    wd.stop();

    expect(exits).toEqual([]);
    expect(fatals).toEqual([]);
  });

  it('fires once — a slow shutdown must not re-log the same verdict', () => {
    const now = START + 60 * MIN;
    const { wd, exits } = harness({ ...healthy(now), lastSlotAtMs: now - 40 * MIN }, now);

    wd.check();
    wd.check();
    wd.check();
    wd.stop();

    expect(exits).toEqual([1]);
  });

  it('stops checking after stop()', () => {
    const now = START + 60 * MIN;
    const marks = vi.fn(() => healthy(now));
    const wd = startWatchdog({
      logger: { fatal: () => {} },
      marks,
      now: () => now,
      exit: () => {},
      intervalMs: 1,
    });
    wd.stop();
    const callsAfterStop = marks.mock.calls.length;

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(marks.mock.calls.length).toBe(callsAfterStop);
        resolve();
      }, 20);
    });
  });
});
