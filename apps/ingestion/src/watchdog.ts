/**
 * Self-kill watchdog for the ingestion worker.
 *
 * Written after the outage of 2026-08-25: the worker ran for forty hours
 * without ingesting a single transaction. It had not crashed — Railway
 * reported the instance `RUNNING` the whole time, `uptimeSec` kept climbing,
 * and the 60s cron timer kept firing. A cron cycle started at 17:33 and never
 * returned, so `running` (cron.ts) stayed true forever and every later tick
 * logged "cron cycle skipped — previous cycle still running". The heartbeat
 * writes hung on the same wedged network, so the row froze mid-outage.
 *
 * Every layer of monitoring worked. `/health/ingestion` went 503, the uptime
 * workflow went red and paged Telegram. What did not exist was anything that
 * could *act* on that: a process that is alive but doing nothing is invisible
 * to a restart policy keyed on exit codes, and it stays up until a human
 * notices. Forty hours, in this case.
 *
 * So the worker judges itself by the same signals the API judges it by, and
 * when it concludes it is wedged it exits non-zero. `restartPolicyType:
 * ON_FAILURE` in railway.json turns that into a fresh container. Dying is the
 * only recovery available to a process whose event loop is healthy but whose
 * sockets are not — nothing inside it can cancel a `fetch` that will never
 * settle, or reclaim a connection the kernel still thinks is open.
 *
 * Thresholds are deliberately about 2× the API's reporting thresholds. The API
 * reporting 503 costs a red dashboard; a false self-kill costs a restart and a
 * gap in ingestion, so the bar to pull the trigger is set higher than the bar
 * to raise a flag.
 *
 * What is NOT judged: transaction age. A fleet of idle agents produces no
 * transactions for days at a time and that is normal — killing the worker over
 * it would turn a quiet week into a restart loop. This mirrors the same
 * deliberate omission in `health.ts`.
 */

/** Minimal structural logger (pino satisfies this). */
export interface WatchdogLogger {
  fatal: (obj: Record<string, unknown> | string, msg?: string) => void;
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
}

/**
 * Epoch-ms marks the watchdog reasons over. `null` means the signal has never
 * fired in this process; it is then aged from `startedAtMs` so a worker three
 * seconds into its boot does not read as stalled.
 */
export interface WatchdogMarks {
  startedAtMs: number;
  lastSlotAtMs: number | null;
  lastCronTickAtMs: number | null;
  lastWriteOkAtMs: number | null;
}

export type WedgeReason = 'stream-stalled' | 'cron-stalled' | 'heartbeat-write-stalled';

export interface WatchdogVerdict {
  wedged: boolean;
  reason?: WedgeReason;
  /** Age of the offending signal, seconds. */
  ageSec?: number;
}

export interface WatchdogThresholds {
  /**
   * Mainnet produces a slot every ~400ms. Ten minutes of silence is not a slow
   * chain, it is a dead subscription. (API reports `stream-stalled` at 5 min.)
   */
  streamStalledMs: number;
  /**
   * Cycles run every 60s and take tens of ms. Ten minutes without a *completed*
   * one means the current cycle is wedged — the exact 2026-08-25 signature.
   */
  cronStalledMs: number;
  /**
   * Beats are written every 30s. Ten minutes of failed or hanging writes means
   * the database path is gone, and with it the worker's ability to persist
   * anything at all.
   */
  writeStalledMs: number;
  /**
   * Window after process start during which a signal that has NEVER fired is
   * not judged. Default 60 min.
   *
   * This exists because boot is not a steady state. `backfillNewWallets` walks
   * every registered wallet fetching up to 50 historical signatures apiece, and
   * on the 2026-08-27 restart each wallet took 20-45s — over half an hour for
   * 53 agents. The cron competes with that for the RPC and for a 5-connection
   * pool, so the first *completed* cycle can legitimately be 30+ minutes after
   * start. Judged against a 10-minute threshold, that is a self-kill in the
   * middle of every boot: the worker dies, restarts, begins the backfill again,
   * and never reaches a steady state at all.
   *
   * The distinction the watchdog actually wants is not "how old is this signal"
   * but "did it ever work and then stop". A mark that has fired at least once
   * is judged normally from the first second — that is the 2026-08-25 wedge,
   * where every signal was healthy and then froze — while a mark still at
   * `null` gets the benefit of the doubt until the grace expires.
   */
  bootGraceMs: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  streamStalledMs: 600_000,
  cronStalledMs: 600_000,
  writeStalledMs: 600_000,
  bootGraceMs: 60 * 60_000,
};

/**
 * Pure verdict function — exported so the decision can be tested without
 * timers, a process, or a database.
 *
 * Checks run in escalating order of scope: a dead stream is the narrowest
 * failure, a dead database path the broadest. The first match wins, so the
 * reported reason is the most specific one that fits.
 */
export function evaluateWatchdog(
  marks: WatchdogMarks,
  nowMs: number,
  thresholds: WatchdogThresholds = DEFAULT_THRESHOLDS,
): WatchdogVerdict {
  const withinBootGrace = nowMs - marks.startedAtMs < thresholds.bootGraceMs;

  const checks: ReadonlyArray<{ reason: WedgeReason; mark: number | null; limitMs: number }> = [
    {
      reason: 'stream-stalled',
      mark: marks.lastSlotAtMs,
      limitMs: thresholds.streamStalledMs,
    },
    {
      reason: 'cron-stalled',
      mark: marks.lastCronTickAtMs,
      limitMs: thresholds.cronStalledMs,
    },
    {
      reason: 'heartbeat-write-stalled',
      mark: marks.lastWriteOkAtMs,
      limitMs: thresholds.writeStalledMs,
    },
  ];

  for (const check of checks) {
    // A signal that has never fired is only judged once the boot grace is over;
    // before that, "not yet" is indistinguishable from "still warming up".
    if (check.mark === null && withinBootGrace) continue;
    const ageMs = nowMs - (check.mark ?? marks.startedAtMs);
    if (ageMs > check.limitMs) {
      return { wedged: true, reason: check.reason, ageSec: Math.round(ageMs / 1000) };
    }
  }

  return { wedged: false };
}

export interface WatchdogDeps {
  logger: WatchdogLogger;
  /** Current marks. Wire to `heartbeat.marks`. */
  marks: () => WatchdogMarks;
  /** Poll cadence. Default 30s — the check is three subtractions. */
  intervalMs?: number;
  thresholds?: Partial<WatchdogThresholds>;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Injected exit for tests. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function startWatchdog(deps: WatchdogDeps): { stop: () => void; check: () => void } {
  const now = deps.now ?? Date.now;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...deps.thresholds };

  // Once we have decided to die, stop deciding. Without this a slow shutdown
  // would log the same verdict on every subsequent tick.
  let fired = false;

  function check(): void {
    if (fired) return;
    const marks = deps.marks();
    const verdict = evaluateWatchdog(marks, now(), thresholds);
    if (!verdict.wedged) return;

    fired = true;
    deps.logger.fatal(
      {
        reason: verdict.reason,
        ageSec: verdict.ageSec,
        uptimeSec: Math.round((now() - marks.startedAtMs) / 1000),
        marks,
      },
      'watchdog: worker is wedged — exiting so the platform restarts it',
    );
    // Non-zero: railway.json sets restartPolicyType ON_FAILURE, so a clean
    // exit(0) would be read as "the job finished" and nothing would come back.
    exit(1);
  }

  const timer = setInterval(check, intervalMs);
  // The watchdog must never be the reason the process stays alive.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    check,
  };
}
