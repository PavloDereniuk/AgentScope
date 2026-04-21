/**
 * Seed a fake Jupiter swap tx with 50% slippage for the trader agent,
 * run the real detector pipeline against it, and deliver the resulting
 * alert via Telegram — exactly the same path ingestion uses in prod.
 *
 * Unlike trigger-anomaly.ts (which only emits OTel spans), this script
 * writes a row into agent_transactions that the detector actually reads,
 * so the slippage_spike rule fires and the full alert → Telegram flow runs.
 *
 * Run: pnpm --filter @agentscope/scripts seed-anomaly-alert
 *
 * Env vars required:
 *   DATABASE_URL
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_DEFAULT_CHAT_ID
 *   AGENTSCOPE_AGENT_TOKEN_TRADER   (used to locate the target agent)
 *   AGENTSCOPE_SLIPPAGE_PCT_THRESHOLD  (optional override, default 5)
 *   INTERNAL_SECRET                 (optional — if set, publishes SSE tx.new + alert.new
 *                                    so the dashboard refreshes live without manual F5)
 *   AGENTSCOPE_API_URL              (optional, default http://localhost:3000 — API base
 *                                    for /internal/publish when INTERNAL_SECRET is set)
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { createTelegramSender, deliver } from '@agentscope/alerter';
import type { AlertMessage } from '@agentscope/alerter';
import { agentTransactions, agents, alerts, createDb } from '@agentscope/db';
import {
  type DefaultThresholds,
  type TxSnapshot,
  evaluateTx,
  slippageRule,
} from '@agentscope/detector';
import type { AlertRuleThresholds } from '@agentscope/shared';
import { eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TELEGRAM_DEFAULT_CHAT_ID = process.env['TELEGRAM_DEFAULT_CHAT_ID'];
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'];
const INTERNAL_SECRET = process.env['INTERNAL_SECRET'];
const API_URL = (process.env['AGENTSCOPE_API_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!TELEGRAM_DEFAULT_CHAT_ID) throw new Error('TELEGRAM_DEFAULT_CHAT_ID is required');
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

/**
 * Publish a bus event to the API's /internal/publish endpoint so SSE
 * subscribers (the dashboard) see the new tx/alert without a page
 * refresh. Mirrors apps/ingestion/src/event-publisher.ts — same shape,
 * same header, same secret. Silent no-op when INTERNAL_SECRET is absent
 * so the script still works for headless demos.
 */
async function publishBusEvent(
  event:
    | { type: 'tx.new'; agentId: string; signature: string; at: string }
    | { type: 'alert.new'; agentId: string; alertId: string; severity: string; at: string },
): Promise<void> {
  if (!INTERNAL_SECRET) return;
  try {
    const res = await fetch(`${API_URL}/internal/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`SSE publish ${event.type} returned ${res.status}`);
    } else {
      console.info(`↪ SSE ${event.type} published`);
    }
  } catch (err) {
    console.warn(`SSE publish ${event.type} failed:`, err);
  }
}

const defaults: DefaultThresholds = {
  slippagePct: Number(process.env['AGENTSCOPE_SLIPPAGE_PCT_THRESHOLD'] ?? '5'),
  gasMult: Number(process.env['AGENTSCOPE_GAS_MULT_THRESHOLD'] ?? '3'),
  drawdownPct: Number(process.env['AGENTSCOPE_DRAWDOWN_PCT_THRESHOLD'] ?? '10'),
  errorRatePct: Number(process.env['AGENTSCOPE_ERROR_RATE_PCT_THRESHOLD'] ?? '20'),
  staleMinutes: Number(process.env['AGENTSCOPE_STALE_MINUTES_THRESHOLD'] ?? '30'),
};

const db = createDb({ connectionString: DATABASE_URL });

const [agent] = await db
  .select({ id: agents.id, name: agents.name, alertRules: agents.alertRules })
  .from(agents)
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .limit(1);

if (!agent) {
  throw new Error(`No agent found for AGENTSCOPE_AGENT_TOKEN_TRADER=${AGENT_TOKEN}`);
}

console.info(`Target agent: ${agent.name} (${agent.id})`);

// Build a believable-looking Jupiter v6 swap tx with 50% slippage.
const signature = `demo${randomBytes(32).toString('base64url').slice(0, 84)}`;
const blockTime = new Date().toISOString();
const slot = Math.floor(Date.now() / 400); // Solana ~400ms/slot, rough

const parsedArgs = {
  inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  outputMint: 'So11111111111111111111111111111111111111112', // wSOL
  inAmount: '5000000', // 5 USDC
  quotedOutAmount: '33000000', // 0.033 SOL
  slippageBps: 5000, // 50% — 10× the default 5% threshold → critical severity
  platformFeeBps: 0,
};

await db.insert(agentTransactions).values({
  agentId: agent.id,
  signature,
  slot,
  blockTime,
  programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  instructionName: 'jupiter.swap',
  parsedArgs,
  solDelta: '0.033',
  tokenDeltas: [],
  feeLamports: 5000,
  success: true,
  rawLogs: ['Program JUP6... invoke [1]', 'Program JUP6... success'],
});

console.info(`Inserted fake jupiter.swap tx: ${signature}`);

await publishBusEvent({
  type: 'tx.new',
  agentId: agent.id,
  signature,
  at: new Date().toISOString(),
});

// Run the real detector — same call as ingestion's detector-runner.
const txSnapshot: TxSnapshot = {
  signature,
  instructionName: 'jupiter.swap',
  parsedArgs,
  solDelta: '0.033',
  feeLamports: 5000,
  success: true,
  blockTime,
};

const evalLogger = {
  // biome-ignore lint/suspicious/noExplicitAny: pino interface
  info: (...args: any[]) => console.info('[detector]', ...args),
  // biome-ignore lint/suspicious/noExplicitAny: pino interface
  warn: (...args: any[]) => console.warn('[detector]', ...args),
  // biome-ignore lint/suspicious/noExplicitAny: pino interface
  error: (...args: any[]) => console.error('[detector]', ...args),
};

const results = await evaluateTx(
  [slippageRule],
  {
    agent: { id: agent.id, alertRules: (agent.alertRules ?? {}) as AlertRuleThresholds },
    defaults,
    db,
    now: new Date(),
    transaction: txSnapshot,
  },
  evalLogger,
);

console.info(`Rules fired: ${results.length}`, results.map((r) => r.ruleName));

if (results.length === 0) {
  console.error('No alert fired — check thresholds vs slippageBps (expected 5000bps ≥ threshold).');
  process.exit(1);
}

// Insert alert row. Mirror ingestion's dedupe path so repeated runs with
// the same (freshly-generated) signature behave consistently.
const inserted = await db
  .insert(alerts)
  .values(
    results.map((r) => ({
      id: randomUUID(),
      agentId: agent.id,
      ruleName: r.ruleName,
      severity: r.severity,
      payload: r.payload,
      dedupeKey: r.dedupeKey ?? null,
    })),
  )
  .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] })
  .returning({ id: alerts.id, triggeredAt: alerts.triggeredAt });

console.info(`Inserted ${inserted.length} alert row(s)`);

// Deliver via Telegram — same alerter package ingestion uses.
const telegram = createTelegramSender({
  botToken: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_DEFAULT_CHAT_ID,
});

for (let i = 0; i < results.length; i++) {
  const result = results[i];
  const row = inserted[i];
  if (!result || !row) continue;

  const msg: AlertMessage = {
    id: row.id,
    agentId: agent.id,
    agentName: agent.name,
    ruleName: result.ruleName,
    severity: result.severity,
    payload: result.payload,
    triggeredAt: row.triggeredAt,
  };

  await publishBusEvent({
    type: 'alert.new',
    agentId: agent.id,
    alertId: row.id,
    severity: result.severity,
    at: new Date(row.triggeredAt).toISOString(),
  });

  const delivery = await deliver({ telegram }, msg, 'telegram');

  if (delivery.success) {
    await db
      .update(alerts)
      .set({
        deliveredAt: new Date().toISOString(),
        deliveryChannel: 'telegram',
        deliveryStatus: 'delivered',
      })
      .where(eq(alerts.id, row.id));
    console.info(`✓ Alert ${row.id} delivered via Telegram`);
  } else {
    console.error(`✗ Telegram delivery failed: ${delivery.error}`);
  }
}

console.info('\nDone. Check:');
console.info('  - Dashboard: Trade bot 1 → Recent Transactions (new jupiter.swap row)');
console.info('  - Dashboard: Alerts feed → new slippage_spike alert');
console.info('  - Telegram: chat should have a formatted alert message');

process.exit(0);
