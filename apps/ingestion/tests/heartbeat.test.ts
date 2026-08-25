/**
 * Tests for the liveness heartbeat writer (E.13).
 *
 * Runs against PGlite with the real migrations applied, so the upsert is
 * exercised against the actual `service_heartbeats` primary key rather than a
 * mock. The clock is injected; no test waits on a timer.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type HeartbeatDetail,
  type MemorySignals,
  readMemorySignals,
  startHeartbeat,
} from '../src/heartbeat';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

let db: Database;
let pg: PGlite;

const warnings: unknown[] = [];
const logger = {
  warn: (obj: Record<string, unknown> | string) => {
    warnings.push(obj);
  },
};

/** Fixed clock, advanced explicitly by tests. */
let clock = Date.parse('2026-08-22T12:00:00.000Z');
const now = () => clock;

beforeEach(async () => {
  warnings.length = 0;
  clock = Date.parse('2026-08-22T12:00:00.000Z');
  pg = new PGlite();
  await pg.waitReady;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    const stmts = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of stmts) {
      await pg.exec(stmt);
    }
  }
  db = drizzle(pg) as unknown as Database;
});

afterEach(async () => {
  await pg.close();
});

interface Row {
  service: string;
  beat_at: string;
  detail: HeartbeatDetail;
}

async function rows(): Promise<Row[]> {
  const res = await pg.query<Row>('SELECT service, beat_at, detail FROM service_heartbeats');
  return res.rows;
}

describe('startHeartbeat', () => {
  it('writes a row immediately on boot, before any signal has fired', async () => {
    // A worker that dies during startup still leaves evidence that it booted
    // and how far it got — the row is the only trace a crash-loop leaves.
    const hb = startHeartbeat({ db, logger, now, intervalMs: 60_000 });
    await hb.beat();
    hb.stop();

    const [row] = await rows();
    expect(row?.service).toBe('ingestion');
    expect(row?.detail.startedAt).toBe('2026-08-22T12:00:00.000Z');
    expect(row?.detail.lastSlotAt).toBeNull();
    expect(row?.detail.lastCronTickAt).toBeNull();
    expect(row?.detail.registeredAgents).toBe(0);
  });

  it('carries the signals recorded since the last beat', async () => {
    const hb = startHeartbeat({ db, logger, now, intervalMs: 60_000 });
    hb.setRegisteredAgents(57);
    clock += 1_000;
    hb.markSlot();
    clock += 2_000;
    hb.markTx();
    clock += 3_000;
    hb.markCronTick();
    clock += 1_000;
    await hb.beat();
    hb.stop();

    const [row] = await rows();
    expect(row?.detail).toMatchObject({
      startedAt: '2026-08-22T12:00:00.000Z',
      lastSlotAt: '2026-08-22T12:00:01.000Z',
      lastTxAt: '2026-08-22T12:00:03.000Z',
      lastCronTickAt: '2026-08-22T12:00:06.000Z',
      registeredAgents: 57,
    });
    expect(row?.beat_at).toBeTruthy();
  });

  it('upserts one row per service rather than accumulating history', async () => {
    // The table is a liveness register, not a log: unbounded growth on a
    // 30s cadence would eat the 500 MB free-tier budget for nothing.
    const hb = startHeartbeat({ db, logger, now, intervalMs: 60_000 });
    await hb.beat();
    clock += 30_000;
    hb.markSlot();
    await hb.beat();
    clock += 30_000;
    await hb.beat();
    hb.stop();

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.detail.lastSlotAt).toBe('2026-08-22T12:00:30.000Z');
    expect(Date.parse(all[0]?.beat_at ?? '')).toBe(clock);
  });

  it('swallows and logs a failed write instead of taking the worker down', async () => {
    // The monitoring path must never be able to kill the process it monitors,
    // and a missing beat is already the signal the reader needs.
    const broken = {
      insert: () => {
        throw new Error('connection terminated');
      },
    } as unknown as Database;
    const hb = startHeartbeat({ db: broken, logger, now, intervalMs: 60_000 });

    await expect(hb.beat()).resolves.toBeUndefined();
    hb.stop();
    // Two warnings: the beat fired on construction and the explicit one.
    expect(warnings).toHaveLength(2);
  });

  it('stops writing after stop()', async () => {
    const hb = startHeartbeat({ db, logger, now, intervalMs: 1 });
    await hb.beat();
    hb.stop();
    const after = await rows();
    clock += 30_000;
    await new Promise((r) => setTimeout(r, 20));
    expect(await rows()).toEqual(after);
  });

  it('exposes the in-memory snapshot without touching the database', () => {
    const hb = startHeartbeat({ db, logger, now, intervalMs: 60_000 });
    hb.markSlot();
    hb.setRegisteredAgents(4);
    const snap = hb.snapshot();
    hb.stop();

    expect(snap.lastSlotAt).toBe('2026-08-22T12:00:00.000Z');
    expect(snap.registeredAgents).toBe(4);
    expect(snap.lastTxAt).toBeNull();
  });
});

describe('memory signals', () => {
  const sample: MemorySignals = {
    rssMb: 820,
    heapUsedMb: 401,
    heapTotalMb: 470,
    heapLimitMb: 512,
    externalMb: 96,
    arrayBuffersMb: 64,
  };

  /** Logger that captures the structured payload of every info line. */
  function capturingLogger() {
    const infos: Array<{ obj: Record<string, unknown> | string; msg?: string | undefined }> = [];
    return {
      logger: {
        warn: (obj: Record<string, unknown> | string) => {
          warnings.push(obj);
        },
        info: (obj: Record<string, unknown> | string, msg?: string) => {
          infos.push({ obj, msg });
        },
      },
      infos,
    };
  }

  it('persists the memory sample alongside the liveness signals', async () => {
    const hb = startHeartbeat({
      db,
      logger,
      now,
      intervalMs: 60_000,
      readMemory: () => sample,
    });
    await hb.beat();
    hb.stop();

    const [row] = await rows();
    expect(row?.detail.memory).toEqual(sample);
  });

  it('logs the first beat and then every Nth, not every beat', async () => {
    // The row holds only the latest sample, so the log carries the trend —
    // but at the 30s beat cadence one line per beat would be 2880/day.
    const { logger: cap, infos } = capturingLogger();
    const hb = startHeartbeat({
      db,
      logger: cap,
      now,
      intervalMs: 60_000,
      readMemory: () => sample,
      memoryLogEveryNBeats: 3,
    });

    for (let i = 0; i < 7; i++) {
      clock += 30_000;
      await hb.beat();
    }
    hb.stop();

    // Beats 0, 3 and 6 of the seven.
    expect(infos).toHaveLength(3);
    expect(infos[0]?.msg).toBe('memory');
    expect(infos[0]?.obj).toMatchObject(sample);
  });

  it('reports uptime on the log line so a restart is not read as a drop', async () => {
    const { logger: cap, infos } = capturingLogger();
    const hb = startHeartbeat({
      db,
      logger: cap,
      now,
      intervalMs: 60_000,
      readMemory: () => sample,
      memoryLogEveryNBeats: 1,
    });
    clock += 120_000;
    await hb.beat();
    hb.stop();

    // infos[0] is the boot beat startHeartbeat fires synchronously at uptime 0.
    expect(infos[0]?.obj).toMatchObject({ uptimeSec: 0 });
    expect(infos[1]?.obj).toMatchObject({ uptimeSec: 120 });
  });

  it('still beats when the logger has no info method', async () => {
    // HeartbeatLogger.info is optional; a logger without it must not throw.
    const hb = startHeartbeat({
      db,
      logger: { warn: () => {} },
      now,
      intervalMs: 60_000,
      readMemory: () => sample,
    });
    await expect(hb.beat()).resolves.toBeUndefined();
    hb.stop();
  });
});

describe('readMemorySignals', () => {
  it('reads real process numbers in whole MB', () => {
    const mem = readMemorySignals();

    expect(mem.rssMb).toBeGreaterThan(0);
    expect(mem.heapUsedMb).toBeGreaterThan(0);
    // The point of carrying this field: it shows what V8 actually applied, so
    // a --max-old-space-size that never reached the process is visible.
    expect(mem.heapLimitMb).toBeGreaterThan(0);
    expect(mem.heapUsedMb).toBeLessThanOrEqual(mem.heapLimitMb);
    for (const v of Object.values(mem)) expect(Number.isInteger(v)).toBe(true);
  });
});
