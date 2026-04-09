/**
 * Integration test for detector runner (task 5.9).
 *
 * Seeds an agent, calls runTxDetector with a high-slippage tx snapshot,
 * and verifies that an alert row appears in the DB.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, agents, alerts, users } from '@agentscope/db';
import type { DefaultThresholds, TxSnapshot } from '@agentscope/detector';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTxDetector } from '../src/detector-runner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const defaults: DefaultThresholds = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

const silentLogger = {
  error: () => {},
  info: () => {},
};

let db: Database;
let pg: PGlite;
let agentId: string;

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

  const [user] = await db.insert(users).values({ privyDid: 'did:privy:det-runner' }).returning();
  if (!user) throw new Error('seed user failed');

  const [agent] = await db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Detector Runner Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_det_runner',
    })
    .returning();
  if (!agent) throw new Error('seed agent failed');
  agentId = agent.id;
});

afterAll(async () => {
  await pg.close();
});

describe('runTxDetector', () => {
  it('inserts a slippage_spike alert for a Jupiter swap with 50% slippage', async () => {
    const tx: TxSnapshot = {
      signature: 'sig_slippage_50pct',
      instructionName: 'jupiter.swap',
      parsedArgs: { slippageBps: 5000 },
      solDelta: '-1.0',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    };

    const count = await runTxDetector({ db, logger: silentLogger, defaults }, agentId, tx);
    expect(count).toBe(1);

    const rows = await db.select().from(alerts).where(eq(alerts.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ruleName).toBe('slippage_spike');
    expect(rows[0]?.severity).toBe('critical');
    expect(rows[0]?.payload).toMatchObject({ actualPct: 50, thresholdPct: 5 });
  });

  it('does not insert alerts for a normal tx', async () => {
    // Clear previous alerts
    await db.delete(alerts).where(eq(alerts.agentId, agentId));

    const tx: TxSnapshot = {
      signature: 'sig_normal',
      instructionName: 'jupiter.swap',
      parsedArgs: { slippageBps: 100 }, // 1% — well under 5% threshold
      solDelta: '-0.01',
      feeLamports: 5000,
      success: true,
      blockTime: '2026-04-09T12:00:00Z',
    };

    const count = await runTxDetector({ db, logger: silentLogger, defaults }, agentId, tx);
    expect(count).toBe(0);

    const rows = await db.select().from(alerts).where(eq(alerts.agentId, agentId));
    expect(rows).toHaveLength(0);
  });
});
