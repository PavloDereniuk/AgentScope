/**
 * Tests for partition maintenance (agent_transactions storage hygiene).
 *
 * Spins up a PGlite instance, applies every migration (which seeds monthly
 * partitions 2026_04..2026_09 + a default partition), then exercises the
 * roll-forward and TTL-drop logic against the live inheritance catalog with
 * an injected `now` for determinism.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dropOldPartitions,
  ensureFuturePartitions,
  runPartitionMaintenance,
} from '../src/partition-maintenance';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let db: Database;
let pg: PGlite;

/** Fresh DB with all migrations applied. Called before each test so drops in
 *  one test don't bleed into the next. */
async function freshDb(): Promise<void> {
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
}

/** Names of the existing child partitions of agent_transactions. */
async function partitions(): Promise<string[]> {
  const res = await pg.query<{ relname: string }>(`
    SELECT child.relname AS relname
    FROM pg_inherits
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    JOIN pg_class child ON pg_inherits.inhrelid = child.oid
    WHERE parent.relname = 'agent_transactions'
    ORDER BY child.relname
  `);
  return res.rows.map((r) => r.relname);
}

/** Whether row-level security is enabled on a given relation. */
async function rlsEnabled(relname: string): Promise<boolean> {
  const res = await pg.query<{ relrowsecurity: boolean }>(
    'SELECT relrowsecurity FROM pg_class WHERE relname = $1',
    [relname],
  );
  return res.rows[0]?.relrowsecurity ?? false;
}

beforeEach(async () => {
  await freshDb();
});

afterAll(async () => {
  await pg?.close();
});

describe('ensureFuturePartitions', () => {
  it('creates the missing upcoming months past the seeded range', async () => {
    // Seeded migration covers 2026_04..2026_09. From 2026-09, 3 months ahead
    // means 2026_09 (exists) + 2026_10, 2026_11, 2026_12 (new).
    const created = await ensureFuturePartitions(db, {
      monthsAhead: 3,
      now: new Date('2026-09-15T00:00:00Z'),
      logger: silentLogger,
    });

    expect(created.sort()).toEqual([
      'agent_transactions_2026_10',
      'agent_transactions_2026_11',
      'agent_transactions_2026_12',
    ]);

    const all = await partitions();
    expect(all).toContain('agent_transactions_2026_10');
    expect(all).toContain('agent_transactions_2026_12');
  });

  it('is idempotent — a second pass creates nothing', async () => {
    const opts = {
      monthsAhead: 3,
      now: new Date('2026-09-15T00:00:00Z'),
      logger: silentLogger,
    };
    await ensureFuturePartitions(db, opts);
    const secondPass = await ensureFuturePartitions(db, opts);
    expect(secondPass).toEqual([]);
  });

  it('enables RLS on every newly created partition (PostgREST exposure guard)', async () => {
    // A new partition inherits no RLS from the parent, and Supabase PostgREST
    // exposes each one as its own endpoint — so roll-forward must flip RLS on
    // or it silently regresses migration 0014 every month.
    await ensureFuturePartitions(db, {
      monthsAhead: 1,
      now: new Date('2026-09-15T00:00:00Z'),
      logger: silentLogger,
    });
    expect(await rlsEnabled('agent_transactions_2026_10')).toBe(true);
  });

  it('crosses a year boundary correctly', async () => {
    const created = await ensureFuturePartitions(db, {
      monthsAhead: 2,
      now: new Date('2026-11-10T00:00:00Z'),
      logger: silentLogger,
    });
    // 2026_11 (new), 2026_12 (new), 2027_01 (new)
    expect(created).toContain('agent_transactions_2027_01');
  });
});

describe('dropOldPartitions', () => {
  it('drops months older than the retention window, keeps recent + default', async () => {
    // retention=2, now=2026-09 → keep 2026_09 + 2026_08; drop 04/05/06/07.
    const dropped = await dropOldPartitions(db, {
      retentionMonths: 2,
      now: new Date('2026-09-15T00:00:00Z'),
      logger: silentLogger,
    });

    expect(dropped.sort()).toEqual([
      'agent_transactions_2026_04',
      'agent_transactions_2026_05',
      'agent_transactions_2026_06',
      'agent_transactions_2026_07',
    ]);

    const all = await partitions();
    expect(all).toContain('agent_transactions_2026_08');
    expect(all).toContain('agent_transactions_2026_09');
    // The default partition must NEVER be dropped.
    expect(all).toContain('agent_transactions_default');
  });

  it('is a no-op when retention is disabled (0)', async () => {
    const before = await partitions();
    const dropped = await dropOldPartitions(db, {
      retentionMonths: 0,
      now: new Date('2026-12-15T00:00:00Z'),
      logger: silentLogger,
    });
    expect(dropped).toEqual([]);
    expect(await partitions()).toEqual(before);
  });

  it('actually frees the rows held by a dropped partition', async () => {
    // Insert a tx into the April partition, then drop it and confirm the row
    // is gone (proves DROP TABLE reclaims storage, not just metadata).
    const { rows: userRows } = await pg.query<{ id: string }>(
      `INSERT INTO users (privy_did) VALUES ('did:privy:part-test') RETURNING id`,
    );
    const userId = userRows[0]?.id;
    const { rows: agentRows } = await pg.query<{ id: string }>(
      `INSERT INTO agents (user_id, wallet_pubkey, name, framework, agent_type, ingest_token)
       VALUES ('${userId}', '11111111111111111111111111111111', 'p', 'custom', 'other', 'tok_part')
       RETURNING id`,
    );
    const agentId = agentRows[0]?.id;
    await pg.query(
      `INSERT INTO agent_transactions
         (agent_id, signature, slot, block_time, program_id, success)
       VALUES ('${agentId}', 'sig_old', 1, '2026-04-10 00:00:00+00', '11111111111111111111111111111111', true)`,
    );

    const countBefore = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_transactions WHERE signature = 'sig_old'`,
    );
    expect(countBefore.rows[0]?.c).toBe(1);

    await dropOldPartitions(db, {
      retentionMonths: 2,
      now: new Date('2026-09-15T00:00:00Z'),
      logger: silentLogger,
    });

    const countAfter = await pg.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM agent_transactions WHERE signature = 'sig_old'`,
    );
    expect(countAfter.rows[0]?.c).toBe(0);
  });
});

describe('runPartitionMaintenance', () => {
  it('rolls forward and drops in a single pass', async () => {
    const { created, dropped } = await runPartitionMaintenance({
      db,
      logger: silentLogger,
      monthsAhead: 3,
      retentionMonths: 2,
      now: new Date('2026-09-15T00:00:00Z'),
    });

    expect(created).toContain('agent_transactions_2026_12');
    expect(dropped).toContain('agent_transactions_2026_04');

    const all = await partitions();
    expect(all).toContain('agent_transactions_2026_12'); // newly created
    expect(all).not.toContain('agent_transactions_2026_04'); // dropped
    expect(all).toContain('agent_transactions_default'); // preserved
  });

  it('does not drop anything when retention is disabled', async () => {
    const { dropped } = await runPartitionMaintenance({
      db,
      logger: silentLogger,
      monthsAhead: 1,
      retentionMonths: 0,
      now: new Date('2026-09-15T00:00:00Z'),
    });
    expect(dropped).toEqual([]);
    expect(await partitions()).toContain('agent_transactions_2026_04');
  });
});
