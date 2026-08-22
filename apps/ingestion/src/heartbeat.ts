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

import { type Database, serviceHeartbeats } from '@agentscope/db';

/** Minimal structural logger (pino satisfies this). */
export interface HeartbeatLogger {
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
}

/** Default service key written by the ingestion worker. */
export const INGESTION_SERVICE = 'ingestion';

/**
 * 30s. Comfortably under the API's 180s staleness threshold, so a single
 * missed write (slow DB, one lost tick) does not read as an outage.
 */
const DEFAULT_INTERVAL_MS = 30_000;

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

  const startedAt = now();
  let lastSlotAt: number | null = null;
  let lastTxAt: number | null = null;
  let lastCronTickAt: number | null = null;
  let registeredAgents = 0;

  function snapshot(): HeartbeatDetail {
    return {
      startedAt: new Date(startedAt).toISOString(),
      lastSlotAt: iso(lastSlotAt),
      lastTxAt: iso(lastTxAt),
      lastCronTickAt: iso(lastCronTickAt),
      registeredAgents,
    };
  }

  async function beat(): Promise<void> {
    const detail = snapshot();
    const beatAt = new Date(now()).toISOString();
    try {
      await deps.db
        .insert(serviceHeartbeats)
        .values({ service, beatAt, detail })
        .onConflictDoUpdate({
          target: serviceHeartbeats.service,
          set: { beatAt, detail },
        });
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
    stop: () => {
      clearInterval(timer);
    },
  };
}
