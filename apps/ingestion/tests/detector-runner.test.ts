/**
 * Integration test for detector runner (task 5.9).
 *
 * Seeds an agent, calls runTxDetector with a high-slippage tx snapshot,
 * and verifies that an alert row appears in the DB.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlertMessage, ChannelSender, DeliveryResult } from '@agentscope/alerter';
import { type Database, agents, alerts, users } from '@agentscope/db';
import type { DefaultThresholds, TxSnapshot } from '@agentscope/detector';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runTxDetector } from '../src/detector-runner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const defaults: DefaultThresholds = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
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
      slot: 300_000_100,
      instructionName: 'jupiter.swap',
      parsedArgs: { slippageBps: 5000 },
      solDelta: '-1.0',
      tokenDeltas: [],
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
      slot: 300_000_101,
      instructionName: 'jupiter.swap',
      parsedArgs: { slippageBps: 100 }, // 1% — well under 5% threshold
      solDelta: '-0.01',
      tokenDeltas: [],
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

describe('runTxDetector — Epic 14 per-agent routing', () => {
  /**
   * Factory for a mock telegram/webhook sender that records the
   * AlertMessage it received. Tests assert on these captured messages
   * to prove that the runner forwards per-agent chatId/webhookUrl.
   */
  function createMockSender(): ChannelSender & { captured: AlertMessage[] } {
    const captured: AlertMessage[] = [];
    const sender: ChannelSender & { captured: AlertMessage[] } = {
      captured,
      send: vi.fn(async (msg: AlertMessage): Promise<DeliveryResult> => {
        captured.push(msg);
        return { success: true, channel: 'telegram' };
      }),
    };
    return sender;
  }

  async function seedAgent(opts: {
    name: string;
    telegramChatId?: string | null;
    webhookUrl?: string | null;
  }): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ privyDid: `did:privy:${opts.name.replace(/\s+/g, '-').toLowerCase()}` })
      .returning();
    if (!user) throw new Error('seed user failed');

    const [agent] = await db
      .insert(agents)
      .values({
        userId: user.id,
        // 32-char pubkey shape — reuse agent index for uniqueness
        walletPubkey: `1111111111111111111111111111111${opts.name.charCodeAt(0) % 10}`,
        name: opts.name,
        framework: 'custom',
        agentType: 'other',
        ingestToken: `tok_${opts.name.replace(/\s+/g, '_')}`,
        telegramChatId: opts.telegramChatId ?? null,
        webhookUrl: opts.webhookUrl ?? null,
      })
      .returning();
    if (!agent) throw new Error('seed agent failed');
    return agent.id;
  }

  const slippageTx: TxSnapshot = {
    signature: 'sig_epic14_routing',
    slot: 300_000_200,
    instructionName: 'jupiter.swap',
    parsedArgs: { slippageBps: 5000 },
    solDelta: '-1.0',
    tokenDeltas: [],
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T12:00:00Z',
  };

  it('passes per-agent telegramChatId through to AlertMessage.chatId', async () => {
    const agentAId = await seedAgent({ name: 'Agent A', telegramChatId: '111' });
    const agentBId = await seedAgent({ name: 'Agent B', telegramChatId: '222' });
    const telegram = createMockSender();

    await runTxDetector({ db, logger: silentLogger, defaults, alerter: { telegram } }, agentAId, {
      ...slippageTx,
      signature: `${slippageTx.signature}_A`,
    });
    await runTxDetector({ db, logger: silentLogger, defaults, alerter: { telegram } }, agentBId, {
      ...slippageTx,
      signature: `${slippageTx.signature}_B`,
    });

    expect(telegram.captured).toHaveLength(2);
    expect(telegram.captured[0]?.chatId).toBe('111');
    expect(telegram.captured[1]?.chatId).toBe('222');
    expect(telegram.captured[0]?.agentName).toBe('Agent A');
    expect(telegram.captured[1]?.agentName).toBe('Agent B');
  });

  it('agent with webhookUrl routes via webhook, skipping telegram', async () => {
    const webhookAgentId = await seedAgent({
      name: 'Webhook Agent',
      webhookUrl: 'https://example.com/hooks/abc',
    });
    const telegram = createMockSender();

    // Stub global fetch — createWebhookSender uses it internally.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    try {
      const count = await runTxDetector(
        { db, logger: silentLogger, defaults, alerter: { telegram } },
        webhookAgentId,
        { ...slippageTx, signature: `${slippageTx.signature}_webhook` },
      );
      expect(count).toBe(1);

      // Telegram must NOT have been called — webhook took precedence.
      expect(telegram.captured).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.agent.name).toBe('Webhook Agent');
      expect(body.alert.ruleName).toBe('slippage_spike');

      // Alert row should record delivery_channel = 'webhook'.
      const [row] = await db
        .select({ channel: alerts.deliveryChannel, status: alerts.deliveryStatus })
        .from(alerts)
        .where(eq(alerts.agentId, webhookAgentId));
      expect(row?.channel).toBe('webhook');
      expect(row?.status).toBe('delivered');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('skips telegram delivery when agent has no telegramChatId and no webhookUrl (multi-tenant safety)', async () => {
    const bareAgentId = await seedAgent({ name: 'Bare Agent' });
    const telegram = createMockSender();

    const count = await runTxDetector(
      { db, logger: silentLogger, defaults, alerter: { telegram } },
      bareAgentId,
      { ...slippageTx, signature: `${slippageTx.signature}_bare` },
    );
    // The alert STILL lands in the DB (count === 1) — we just don't ship
    // it to the platform owner's chat via fallback. The row stays in the
    // default 'pending' delivery_status and is visible in the dashboard.
    expect(count).toBe(1);
    expect(telegram.captured).toHaveLength(0);

    const [row] = await db
      .select({ channel: alerts.deliveryChannel, status: alerts.deliveryStatus })
      .from(alerts)
      .where(eq(alerts.agentId, bareAgentId));
    expect(row?.channel).toBeNull();
    expect(row?.status).toBe('pending');
  });
});

describe('runTxDetector — Epic 18 per-rule pause', () => {
  function createMockTelegram(): ChannelSender & { captured: AlertMessage[] } {
    const captured: AlertMessage[] = [];
    const sender: ChannelSender & { captured: AlertMessage[] } = {
      captured,
      send: vi.fn(async (msg: AlertMessage): Promise<DeliveryResult> => {
        captured.push(msg);
        return { success: true, channel: 'telegram' };
      }),
    };
    return sender;
  }

  async function seedAgent(opts: {
    name: string;
    telegramChatId?: string | null;
    alertRules?: Record<string, unknown>;
    alertsPausedUntil?: string | null;
  }): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ privyDid: `did:privy:e18-${opts.name.replace(/\s+/g, '-').toLowerCase()}` })
      .returning();
    if (!user) throw new Error('seed user failed');

    const [agent] = await db
      .insert(agents)
      .values({
        userId: user.id,
        walletPubkey: `1111111111111111111111111111111${opts.name.charCodeAt(0) % 10}`,
        name: opts.name,
        framework: 'custom',
        agentType: 'other',
        ingestToken: `tok_${opts.name.replace(/\s+/g, '_')}_e18`,
        telegramChatId: opts.telegramChatId ?? '999000111',
        alertRules: opts.alertRules ?? {},
        alertsPausedUntil: opts.alertsPausedUntil ?? null,
      })
      .returning();
    if (!agent) throw new Error('seed agent failed');
    return agent.id;
  }

  const slippageTx: TxSnapshot = {
    signature: 'sig_e18_pause',
    slot: 300_000_300,
    instructionName: 'jupiter.swap',
    parsedArgs: { slippageBps: 5000 },
    solDelta: '-1.0',
    tokenDeltas: [],
    feeLamports: 5000,
    success: true,
    blockTime: '2026-04-09T12:00:00Z',
  };

  it('inserts the alert with deliveryStatus=skipped and skips sender when per-rule pausedUntil is future', async () => {
    const id = await seedAgent({
      name: 'E18 Rule Paused',
      alertRules: {
        // pausedUntil 100 years out — well past any test clock.
        pausedUntil: { slippage_spike: '2126-01-01T00:00:00Z' },
      },
    });
    const telegram = createMockTelegram();

    const count = await runTxDetector(
      { db, logger: silentLogger, defaults, alerter: { telegram } },
      id,
      { ...slippageTx, signature: `${slippageTx.signature}_rule_paused` },
    );
    expect(count).toBe(1);

    // Alert row still lands (audit trail), but with skipped status + the
    // channel that *would* have shipped it recorded.
    const [row] = await db
      .select({ status: alerts.deliveryStatus, channel: alerts.deliveryChannel })
      .from(alerts)
      .where(eq(alerts.agentId, id));
    expect(row?.status).toBe('skipped');
    expect(row?.channel).toBe('telegram');

    // Sender MUST NOT have been called.
    expect(telegram.captured).toHaveLength(0);
  });

  it('delivers normally when per-rule pausedUntil is in the past (auto-resume)', async () => {
    const id = await seedAgent({
      name: 'E18 Rule Resumed',
      alertRules: {
        pausedUntil: { slippage_spike: '2020-01-01T00:00:00Z' },
      },
    });
    const telegram = createMockTelegram();

    await runTxDetector({ db, logger: silentLogger, defaults, alerter: { telegram } }, id, {
      ...slippageTx,
      signature: `${slippageTx.signature}_rule_resumed`,
    });

    const [row] = await db
      .select({ status: alerts.deliveryStatus, channel: alerts.deliveryChannel })
      .from(alerts)
      .where(eq(alerts.agentId, id));
    expect(row?.status).toBe('delivered');
    expect(row?.channel).toBe('telegram');
    expect(telegram.captured).toHaveLength(1);
    expect(telegram.captured[0]?.ruleName).toBe('slippage_spike');
  });

  it('global pause trumps per-rule resume (skipped, sender not called)', async () => {
    const id = await seedAgent({
      name: 'E18 Global Trumps',
      // Global pause active …
      alertsPausedUntil: '2126-01-01T00:00:00Z',
      // … even though per-rule is in the past (would auto-resume on its own).
      alertRules: { pausedUntil: { slippage_spike: '2020-01-01T00:00:00Z' } },
    });
    const telegram = createMockTelegram();

    await runTxDetector({ db, logger: silentLogger, defaults, alerter: { telegram } }, id, {
      ...slippageTx,
      signature: `${slippageTx.signature}_global_trumps`,
    });

    const [row] = await db
      .select({ status: alerts.deliveryStatus })
      .from(alerts)
      .where(eq(alerts.agentId, id));
    expect(row?.status).toBe('skipped');
    expect(telegram.captured).toHaveLength(0);
  });
});
