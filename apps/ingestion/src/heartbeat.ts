/**
 * Service liveness heartbeat (post-MVP roadmap E.13).
 *
 * The ingestion worker upserts one `service_heartbeats` row on a short timer.
 * The API reads it to answer `GET /health/ingestion`, and the keep-alive
 * workflow turns a stale row into a Telegram message. That chain is the whole
 * point: before it existed, the only thing anyone watched was the API's own
 * `/health`, and on 2026-07-30 ingestion crash-looped on an INSERT with an
 * unknown enum value and stayed dead for twelve days while `/health` kept
 * answering 200.
 *
 * Two design notes:
 *
 *   - The beat carries *signals*, not just a timestamp. A process that is up
 *     but whose WebSocket has silently stopped delivering slots is dead in
 *     every way a user cares about, and the row is the only place a reader can
 *     see that. `markSlot` is called on every slot notification (~2.5/s on
 *     mainnet), so it does nothing but assign a number; the write happens on
 *     the timer.
 *
 *   - A failing beat never propagates. If the database is unreachable, the
 *     worker's job is to keep retrying its real work, not to die on the
 *     monitoring path — and the missing beat is itself the signal the reader
 *     needs.
 */

import { getHeapStatistics } from 'node:v8';
import { type Database, serviceHeartbeats } from '@agentscope/db';

/** Minimal structural logger (pino satisfies this). */
export interface HeartbeatLogger {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
}

/** Default service key written by the ingestion worker. */
export const INGESTION_SERVICE = 'ingestion';

/**
 * 30s. Comfortably under the API's 180s staleness threshold, so a single
 * missed write (slow DB, one lost tick) does not read as an outage.
 */
const DEFAULT_INTERVAL_MS = 30_000;

/** One memory log line per 10 beats — 5 minutes at the default cadence. */
const DEFAULT_MEMORY_LOG_EVERY_N_BEATS = 10;

/**
 * Liveness signals persisted in `service_heartbeats.detail`.
 *
 * Every field is optional from the reader's point of view — a signal added
 * here reaches production before the reader that understands it, and an older
 * writer must not make a newer reader throw.
 */
// A type alias, not an interface: drizzle's jsonb column takes
// `Record<string, unknown>`, and only an alias picks up the implicit index
// signature that makes it assignable.
/**
 * Process memory at beat time, in whole MB.
 *
 * Added Aug 2026 to settle a question the Railway RAM graph cannot answer.
 * That graph plots one number per project, and a slow climb inside it has two
 * completely different explanations:
 *
 *   - `heapUsed` climbing toward `heapLimit` — V8 lazily filling the budget it
 *     was given. Benign: it plateaus at the cap and stays there.
 *   - `external` / `arrayBuffers` climbing — Buffers, TLS sockets and undici
 *     pools, which live OUTSIDE the heap and which `--max-old-space-size` does
 *     not bound at all. That one is a real leak and the cap cannot stop it.
 *
 * `heapLimitMb` is here as its own check: it reports what V8 actually applied,
 * so a `--max-old-space-size` that never reached the process (wrong start
 * command, flag swallowed by a wrapper) is visible as a number in the thousands
 * instead of being silently assumed to work.
 */
export interface MemorySignals {
  /** Resident set size — the number Railway bills on. */
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  /** V8's own old-space ceiling. Reflects `--max-old-space-size` when applied. */
  heapLimitMb: number;
  /** Native allocations tied to JS objects. Not bounded by the heap cap. */
  externalMb: number;
  /** Subset of `external` held by ArrayBuffers/Buffers. */
  arrayBuffersMb: number;
}

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/** Sample the current process. Cheap — both calls are synchronous reads. */
export function readMemorySignals(): MemorySignals {
  const mem = process.memoryUsage();
  return {
    rssMb: toMb(mem.rss),
    heapUsedMb: toMb(mem.heapUsed),
    heapTotalMb: toMb(mem.heapTotal),
    heapLimitMb: toMb(getHeapStatistics().heap_size_limit),
    externalMb: toMb(mem.external),
    arrayBuffersMb: toMb(mem.arrayBuffers),
  };
}

export type HeartbeatDetail = {
  /** ISO time the worker process started. */
  startedAt: string;
  /** ISO time of the last slot notification on the WebSocket, if any. */
  lastSlotAt: string | null;
  /** ISO time of the last transaction handed to `persistTx`, if any. */
  lastTxAt: string | null;
  /** ISO time of the last completed cron cycle, if any. */
  lastCronTickAt: string | null;
  /** Wallets currently subscribed to, as of the last registry reconcile. */
  registeredAgents: number;
  /** Process memory at beat time. See `MemorySignals`. */
  memory: MemorySignals;
};

export interface HeartbeatDeps {
  db: Database;
  logger: HeartbeatLogger;
  /** Write cadence. Default 30s. */
  intervalMs?: number;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Service key. Default `ingestion`. */
  service?: string;
  /** Injected memory sampler for deterministic tests. */
  readMemory?: () => MemorySignals;
  /**
   * How many beats between memory log lines. The heartbeat row only ever holds
   * the LATEST sample (it is a single upserted row per service), so the trend —
   * the whole point of collecting this — has to live somewhere append-only.
   * Railway's log search is that place. Default 10, i.e. one line per 5 min at
   * the 30s beat cadence: dense enough to see a slope within a couple of hours,
   * sparse enough not to drown the log.
   */
  memoryLogEveryNBeats?: number;
}

export interface Heartbeat {
  /** Record a slot notification from the WebSocket stream. Hot path — O(1). */
  markSlot: () => void;
  /** Record a transaction received for persistence. */
  markTx: () => void;
  /** Record a completed cron cycle. */
  markCronTick: () => void;
  /** Record the current subscribed-wallet count. */
  setRegisteredAgents: (count: number) => void;
  /** Write the current signals now. Resolves even when the write fails. */
  beat: () => Promise<void>;
  /** Current in-memory signals — exposed for tests and diagnostics. */
  snapshot: () => HeartbeatDetail;
  /**
   * Raw epoch-ms marks, for consumers that compare ages rather than display
   * them — the watchdog. `lastWriteOkAtMs` is the one signal `snapshot()`
   * cannot carry: it records the last beat that actually *reached* the
   * database, which is exactly what a worker with a wedged network loses first
   * and what the frozen row can no longer tell anyone from the outside.
   */
  marks: () => {
    startedAtMs: number;
    lastSlotAtMs: number | null;
    lastTxAtMs: number | null;
    lastCronTickAtMs: number | null;
    lastWriteOkAtMs: number | null;
  };
  stop: () => void;
}

/** Epoch ms → ISO string, passing null through. */
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Start the heartbeat writer. Writes once immediately (so a booted worker is
 * visible without waiting a full interval) and then every `intervalMs`.
 */
export function startHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const now = deps.now ?? Date.now;
  const service = deps.service ?? INGESTION_SERVICE;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const readMemory = deps.readMemory ?? readMemorySignals;
  const memoryLogEvery = deps.memoryLogEveryNBeats ?? DEFAULT_MEMORY_LOG_EVERY_N_BEATS;

  const startedAt = now();
  let lastSlotAt: number | null = null;
  let lastTxAt: number | null = null;
  let lastCronTickAt: number | null = null;
  let registeredAgents = 0;
  let beatCount = 0;
  let lastWriteOkAt: number | null = null;

  function snapshot(): HeartbeatDetail {
    return {
      startedAt: new Date(startedAt).toISOString(),
      lastSlotAt: iso(lastSlotAt),
      lastTxAt: iso(lastTxAt),
      lastCronTickAt: iso(lastCronTickAt),
      registeredAgents,
      memory: readMemory(),
    };
  }

  async function beat(): Promise<void> {
    const detail = snapshot();
    const beatAt = new Date(now()).toISOString();

    // Emit the trend line before the write, not after: if the database is
    // unreachable the memory series is exactly what we still want, and the
    // write below deliberately swallows its own failure.
    if (beatCount % memoryLogEvery === 0) {
      deps.logger.info?.(
        { ...detail.memory, uptimeSec: Math.round((now() - startedAt) / 1000) },
        'memory',
      );
    }
    beatCount++;
    try {
      await deps.db
        .insert(serviceHeartbeats)
        .values({ service, beatAt, detail })
        .onConflictDoUpdate({
          target: serviceHeartbeats.service,
          set: { beatAt, detail },
        });
      // Only a write that returned marks the database path as alive. A write
      // that threw — or one that never settles, which is what the 2026-08-25
      // wedge looked like — leaves this mark where it was, and the watchdog
      // ages it.
      lastWriteOkAt = now();
    } catch (err) {
      // Never rethrow: the monitoring path must not be able to take down the
      // process it monitors. A missed write shows up as a stale row, which is
      // exactly the signal the reader is looking for.
      deps.logger.warn({ err, service }, 'heartbeat write failed');
    }
  }

  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  // Do not hold the event loop open on the heartbeat alone.
  timer.unref?.();

  void beat();

  return {
    markSlot: () => {
      lastSlotAt = now();
    },
    markTx: () => {
      lastTxAt = now();
    },
    markCronTick: () => {
      lastCronTickAt = now();
    },
    setRegisteredAgents: (count: number) => {
      registeredAgents = count;
    },
    beat,
    snapshot,
    marks: () => ({
      startedAtMs: startedAt,
      lastSlotAtMs: lastSlotAt,
      lastTxAtMs: lastTxAt,
      lastCronTickAtMs: lastCronTickAt,
      lastWriteOkAtMs: lastWriteOkAt,
    }),
    stop: () => {
      clearInterval(timer);
    },
  };
}
