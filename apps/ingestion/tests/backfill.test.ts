/**
 * Tests for the backfill "already persisted" filter (E.16).
 *
 * Backfill runs for every registered wallet on every worker start. Before
 * E.16 it called getTransaction for all N recent signatures and let
 * ON CONFLICT DO NOTHING discard the ones already stored — ~50 RPC calls
 * per wallet per restart for rows the DB already had.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, agentTransactions, agents, users } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filterUnpersistedSignatures } from '../src/backfill';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

let db: Database;
let pg: PGlite;
let agentId: string;
let otherAgentId: string;

beforeAll(async () => {
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

  const [user] = await db.insert(users).values({ privyDid: 'did:privy:backfill' }).returning();
  if (!user) throw new Error('seed user failed');
  const seeded = await db
    .insert(agents)
    .values([
      {
        userId: user.id,
        walletPubkey: '11111111111111111111111111111111',
        name: 'Backfill Agent',
        framework: 'custom',
        agentType: 'other',
        ingestToken: 'tok_backfill_a',
      },
      {
        userId: user.id,
        walletPubkey: '22222222222222222222222222222222',
        name: 'Other Agent',
        framework: 'custom',
        agentType: 'other',
        ingestToken: 'tok_backfill_b',
      },
    ])
    .returning();
  const [a, b] = seeded;
  if (!a || !b) throw new Error('seed agents failed');
  agentId = a.id;
  otherAgentId = b.id;

  const row = (id: string, signature: string) => ({
    agentId: id,
    signature,
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'system.transfer',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
    blockTime: '2026-09-28T12:00:00Z',
  });
  await db
    .insert(agentTransactions)
    .values([
      row(agentId, 'sig_stored_1'),
      row(agentId, 'sig_stored_2'),
      row(otherAgentId, 'sig_new'),
    ]);
});

afterAll(async () => {
  await pg.close();
});

describe('filterUnpersistedSignatures', () => {
  it('drops signatures the agent already has, keeps order of the rest', async () => {
    const out = await filterUnpersistedSignatures(db, agentId, [
      'sig_new',
      'sig_stored_1',
      'sig_other_new',
      'sig_stored_2',
    ]);
    expect(out).toEqual(['sig_new', 'sig_other_new']);
  });

  it('scopes by agent — another agent storing the signature does not hide it', async () => {
    // Same signature can touch two monitored wallets; each agent gets its own row.
    const out = await filterUnpersistedSignatures(db, agentId, ['sig_new']);
    expect(out).toEqual(['sig_new']);
  });

  it('returns [] for an empty input without querying', async () => {
    expect(await filterUnpersistedSignatures(db, agentId, [])).toEqual([]);
  });
});
