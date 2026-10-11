/**
 * Tests for the paid-plan request outbox notifier (roadmap H.1).
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, agents, upgradeRequests, users } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatUpgradeRequest, runUpgradeRequestNotify } from '../src/upgrade-request-notifier';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const silentLogger = { error: () => {}, info: () => {} };

let pg: PGlite;
let db: Database;
let userId: string;

beforeEach(async () => {
  pg = new PGlite();
  await pg.waitReady;
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const text = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pg.exec(stmt);
    }
  }
  db = drizzle(pg) as unknown as Database;

  const [user] = await db.insert(users).values({ privyDid: 'did:privy:buyer' }).returning();
  if (!user) throw new Error('user not inserted');
  userId = user.id;
  await db.insert(agents).values({
    userId,
    walletPubkey: '11111111111111111111111111111111',
    name: 'bot-1',
    framework: 'custom',
    agentType: 'trader',
    ingestToken: 'tok_upgrade_test',
  });
  await db.insert(upgradeRequests).values({
    userId,
    plan: 'team',
    contact: '@buyer',
    agentCount: 25,
    useCase: 'Market-making fleet',
  });
});

afterEach(async () => {
  await pg.close();
});

describe('formatUpgradeRequest', () => {
  it('puts plan, size, contact and use case in the message', () => {
    const text = formatUpgradeRequest({
      plan: 'pro',
      contact: 'a@b.co',
      agentCount: 5,
      useCase: 'DCA bots',
      privyDid: 'did:privy:x',
      currentAgents: 2,
    });
    expect(text).toContain('PRO');
    expect(text).toContain('Wants: 5 agents (has 2)');
    expect(text).toContain('a@b.co');
    expect(text).toContain('DCA bots');
  });
});

describe('runUpgradeRequestNotify', () => {
  it('sends pending rows once and stamps them', async () => {
    const sent: string[] = [];
    const deps = {
      db,
      logger: silentLogger,
      sendAdminMessage: async (t: string) => {
        sent.push(t);
      },
    };

    expect(await runUpgradeRequestNotify(deps)).toBe(1);
    expect(sent[0]).toContain('TEAM');
    expect(sent[0]).toContain('Wants: 25 agents (has 1)');
    expect(sent[0]).toContain('did:privy:buyer');

    expect(await runUpgradeRequestNotify(deps)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('leaves the row pending when Telegram fails', async () => {
    const deps = {
      db,
      logger: silentLogger,
      sendAdminMessage: async () => {
        throw new Error('telegram down');
      },
    };
    expect(await runUpgradeRequestNotify(deps)).toBe(0);
    const [row] = await db.select().from(upgradeRequests);
    expect(row?.notifiedAt).toBeNull();
  });

  it('does not stamp a row revised mid-send', async () => {
    const deps = {
      db,
      logger: silentLogger,
      sendAdminMessage: async () => {
        await db
          .update(upgradeRequests)
          .set({ agentCount: 99, updatedAt: sql`now() + interval '1 second'` })
          .where(eq(upgradeRequests.userId, userId));
      },
    };
    await runUpgradeRequestNotify(deps);
    const [row] = await db.select().from(upgradeRequests);
    expect(row?.notifiedAt).toBeNull();
    expect(row?.agentCount).toBe(99);
  });

  it('is a no-op without an admin sender', async () => {
    expect(await runUpgradeRequestNotify({ db, logger: silentLogger })).toBe(0);
    const [row] = await db.select().from(upgradeRequests);
    expect(row?.notifiedAt).toBeNull();
  });
});
