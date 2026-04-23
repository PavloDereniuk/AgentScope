/**
 * Integration test for cron evaluator (task 5.10).
 *
 * Seeds an agent with no recent transactions (stale for 31 min),
 * runs one cron cycle, and verifies that a stale_agent alert appears.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertMessage, ChannelSender } from '@agentscope/alerter';
import { type Database, agentTransactions, agents, alerts, users } from '@agentscope/db';
import type { DefaultThresholds } from '@agentscope/detector';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCronCycle } from '../src/cron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const defaults: DefaultThresholds = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
};

const silentLogger = { error: () => {}, info: () => {}, warn: () => {} };

let db: Database;
let pg: PGlite;
let staleAgentId: string;
let activeAgentId: string;

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

  const [user] = await db.insert(users).values({ privyDid: 'did:privy:cron-test' }).returning();
  if (!user) throw new Error('seed user failed');

  // Agent A: last tx 31 min ago → stale
  const [stale] = await db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '11111111111111111111111111111111',
      name: 'Stale Cron Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_cron_stale',
    })
    .returning();
  if (!stale) throw new Error('seed stale agent failed');
  staleAgentId = stale.id;

  // 31 min before "now" (2026-04-09T12:00:00Z) = 11:29:00Z
  await db.insert(agentTransactions).values({
    agentId: stale.id,
    signature: 'sig_cron_stale',
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T11:29:00Z',
  });

  // Agent B: last tx 5 min ago → active
  const [active] = await db
    .insert(agents)
    .values({
      userId: user.id,
      walletPubkey: '22222222222222222222222222222222',
      name: 'Active Cron Agent',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_cron_active',
    })
    .returning();
  if (!active) throw new Error('seed active agent failed');
  activeAgentId = active.id;

  await db.insert(agentTransactions).values({
    agentId: active.id,
    signature: 'sig_cron_active',
    slot: 100,
    programId: '11111111111111111111111111111111',
    instructionName: 'jupiter.swap',
    parsedArgs: {},
    solDelta: '0',
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T11:55:00Z',
  });
});

afterAll(async () => {
  await pg.close();
});

describe('cron cycle', () => {
  it('creates stale_agent alert for agent inactive 31 min', async () => {
    // Override `now` by monkey-patching Date temporarily
    const realDate = globalThis.Date;
    const fakeNow = new Date('2026-04-09T12:00:00Z');
    globalThis.Date = class extends realDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(fakeNow.getTime());
        } else {
          // @ts-expect-error — spread into Date ctor
          super(...args);
        }
      }

      static override now() {
        return fakeNow.getTime();
      }
    } as DateConstructor;

    try {
      const count = await runCronCycle({ db, logger: silentLogger, defaults });
      expect(count).toBeGreaterThanOrEqual(1);

      const staleAlerts = await db.select().from(alerts).where(eq(alerts.agentId, staleAgentId));
      const staleAlert = staleAlerts.find((a) => a.ruleName === 'stale_agent');
      expect(staleAlert).toBeDefined();
      expect(staleAlert?.severity).toBe('warning');

      // Active agent should NOT have a stale alert
      const activeAlerts = await db.select().from(alerts).where(eq(alerts.agentId, activeAgentId));
      const activeStale = activeAlerts.find((a) => a.ruleName === 'stale_agent');
      expect(activeStale).toBeUndefined();
    } finally {
      globalThis.Date = realDate;
    }
  });

  it('delivers cron alerts via alerter and publishes SSE events', async () => {
    // Fresh state: clear previous alerts and bump the stale agent's last tx
    // back to 11:29 so evaluateCron picks it up again against our fake clock.
    await db.delete(alerts).where(eq(alerts.agentId, staleAgentId));
    await db.delete(alerts).where(eq(alerts.agentId, activeAgentId));
    await db
      .update(agentTransactions)
      .set({ blockTime: '2026-04-09T11:29:00Z' })
      .where(eq(agentTransactions.agentId, staleAgentId));

    const telegramCalls: AlertMessage[] = [];
    const telegram: ChannelSender = {
      async send(msg) {
        telegramCalls.push(msg);
        return { success: true, channel: 'telegram' };
      },
    };

    type PublishedEvent = { type: string; agentId: string; [key: string]: unknown };
    const published: PublishedEvent[] = [];

    const realDate = globalThis.Date;
    const fakeNow = new Date('2026-04-09T12:00:00Z');
    globalThis.Date = class extends realDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          super(fakeNow.getTime());
        } else {
          // @ts-expect-error — spread into Date ctor
          super(...args);
        }
      }

      static override now() {
        return fakeNow.getTime();
      }
    } as DateConstructor;

    try {
      await runCronCycle({
        db,
        logger: silentLogger,
        defaults,
        alerter: { telegram },
        publishEvent: (event) => published.push(event),
      });

      // Telegram must have received at least the stale_agent alert.
      const staleMsg = telegramCalls.find((m) => m.ruleName === 'stale_agent');
      expect(staleMsg).toBeDefined();
      expect(staleMsg?.agentName).toBe('Stale Cron Agent');

      // Alert row should flip pending → delivered after the sender returns success.
      const staleRow = (
        await db.select().from(alerts).where(eq(alerts.agentId, staleAgentId))
      ).find((a) => a.ruleName === 'stale_agent');
      expect(staleRow?.deliveryStatus).toBe('delivered');
      expect(staleRow?.deliveryChannel).toBe('telegram');
      expect(staleRow?.deliveredAt).not.toBeNull();

      // SSE bus must have seen alert.new for this agent.
      const sseEvent = published.find((e) => e.type === 'alert.new' && e.agentId === staleAgentId);
      expect(sseEvent).toBeDefined();
      expect(sseEvent?.alertId).toBe(staleRow?.id);
    } finally {
      globalThis.Date = realDate;
    }
  });
});
