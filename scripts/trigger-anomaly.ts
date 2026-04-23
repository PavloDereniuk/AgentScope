/**
 * Trigger anomaly — seeds a failing-tx burst so the `error_rate` cron rule
 * fires and the full alert → Telegram flow runs end-to-end.
 *
 * Why this replaces the old span-only flavour: detector rules read from the
 * `agent_transactions` table, not from OTel spans. The previous version
 * emitted swap spans with high `slippageBps` but never wrote any tx rows,
 * so the detector had nothing to evaluate and no alert ever fired.
 *
 * Works as a companion to seed-anomaly-alert.ts (which exercises the
 * tx-triggered `slippage_spike` rule): this one exercises the cron-triggered
 * `error_rate` rule, which is otherwise hard to reproduce because prod
 * demo-trader runs almost never produce failing tx.
 *
 * Writes 6 failed + 1 successful synthetic tx across the last 15 min
 * (~85.7% failure rate, well above the 2× threshold for critical severity
 * on the default 20% threshold), runs the real detector, inserts the
 * alert, delivers it via Telegram, and (optionally) pushes SSE events
 * so the dashboard refreshes live.
 *
 * Run: pnpm --filter @agentscope/scripts trigger-anomaly
 *
 * Env vars required:
 *   DATABASE_URL
 *   TELEGRAM_BOT_TOKEN
 *   AGENTSCOPE_AGENT_TOKEN_TRADER   (used to locate the target agent)
 *
 * Env vars optional:
 *   AGENTSCOPE_ERROR_RATE_PCT_THRESHOLD  (default 20)
 *   TELEGRAM_DEFAULT_CHAT_ID             (fallback when agents.telegram_chat_id is NULL;
 *                                         @deprecated post-Epic 14)
 *   INTERNAL_SECRET                      (if set, publishes SSE alert.new so
 *                                         the dashboard refreshes live)
 *   AGENTSCOPE_API_URL                   (default http://localhost:3000)
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { createTelegramSender, deliver } from '@agentscope/alerter';
import type { AlertMessage } from '@agentscope/alerter';
import { agentTransactions, agents, alerts, createDb } from '@agentscope/db';
import {
  type CronRuleContext,
  type DefaultThresholds,
  errorRateRule,
  evaluateCron,
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
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

/** Mirrors event-publisher.ts; silent no-op when INTERNAL_SECRET is absent. */
async function publishBusEvent(event: {
  type: 'alert.new';
  agentId: string;
  alertId: string;
  severity: string;
  at: string;
}): Promise<void> {
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
  .select({
    id: agents.id,
    name: agents.name,
    alertRules: agents.alertRules,
    telegramChatId: agents.telegramChatId,
  })
  .from(agents)
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .limit(1);

if (!agent) {
  throw new Error(`No agent found for AGENTSCOPE_AGENT_TOKEN_TRADER=${AGENT_TOKEN}`);
}

const resolvedChatId = agent.telegramChatId ?? TELEGRAM_DEFAULT_CHAT_ID;
if (!resolvedChatId) {
  throw new Error(
    `Agent ${agent.name} has no telegram_chat_id set and TELEGRAM_DEFAULT_CHAT_ID is not configured — nowhere to deliver the alert.`,
  );
}
if (!agent.telegramChatId) {
  console.warn(
    `Agent ${agent.name}.telegram_chat_id is NULL — falling back to TELEGRAM_DEFAULT_CHAT_ID (deprecated, set the DB column instead)`,
  );
}

console.info(`Target agent: ${agent.name} (${agent.id})`);

// Spread tx across the last 15 minutes so they all sit inside the rule's
// 1h window while still forming a recent, recognizable burst in the
// dashboard's "Recent Transactions" list.
const FAIL_COUNT = 6;
const SUCCESS_COUNT = 1;
const TOTAL = FAIL_COUNT + SUCCESS_COUNT;
const WINDOW_MIN = 15;
const nowMs = Date.now();
// Solana ~400ms/slot — slot math is only used to fill the NOT NULL column;
// we do not claim these are real slots (signatures are prefixed `demo` so
// the dashboard renders them as synthetic, not Solscan-linkable).
const MS_PER_SLOT = 400;

const txRows = Array.from({ length: TOTAL }, (_, i) => {
  // Evenly distributed across WINDOW_MIN, newest first.
  const ageMs = Math.round((WINDOW_MIN * 60 * 1000 * i) / TOTAL);
  const blockTimeMs = nowMs - ageMs;
  const success = i === 0; // single success is the newest row
  const reason = success ? null : pickFailureReason(i);

  return {
    agentId: agent.id,
    signature: `demo${randomBytes(32).toString('base64url').slice(0, 84)}`,
    slot: Math.floor(blockTimeMs / MS_PER_SLOT),
    blockTime: new Date(blockTimeMs).toISOString(),
    programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    instructionName: 'jupiter.swap',
    parsedArgs: {
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: '5000000',
      slippageBps: 50,
    },
    solDelta: success ? '0.033' : '0',
    tokenDeltas: [],
    feeLamports: 5000,
    success,
    rawLogs: success
      ? ['Program JUP6... invoke [1]', 'Program JUP6... success']
      : ['Program JUP6... invoke [1]', `Program log: Error: ${reason}`, 'Program JUP6... failed'],
  };
});

function pickFailureReason(i: number): string {
  const reasons = [
    'InsufficientLiquidity: price impact too high',
    'SlippageToleranceExceeded',
    'AccountNotFound: user token account missing',
    'InvalidCalculation: quoted out amount mismatch',
    'BlockhashNotFound: transaction expired',
    'ProgramFailedToComplete',
  ];
  return reasons[i % reasons.length] ?? 'UnknownError';
}

await db.insert(agentTransactions).values(txRows);
console.info(
  `Inserted ${TOTAL} synthetic tx rows (${FAIL_COUNT} failed, ${SUCCESS_COUNT} ok) across the last ${WINDOW_MIN} min`,
);

// Run the real detector — same call as ingestion's cron does every 60s.
const ctx: CronRuleContext = {
  agent: {
    id: agent.id,
    alertRules: (agent.alertRules ?? {}) as AlertRuleThresholds,
  },
  defaults,
  db,
  now: new Date(),
};

const evalLogger = {
  // biome-ignore lint/suspicious/noExplicitAny: pino interface
  error: (...args: any[]) => console.error('[detector]', ...args),
};

const results = await evaluateCron([errorRateRule], ctx, evalLogger);
console.info(`Rules fired: ${results.length}`, results.map((r) => r.ruleName));

if (results.length === 0) {
  console.error(
    'No alert fired — the detector saw fewer failing tx than the error_rate threshold. Check AGENTSCOPE_ERROR_RATE_PCT_THRESHOLD or any existing success tx in the 1h window.',
  );
  process.exit(1);
}

// Insert alert rows with the same dedupe target ingestion uses.
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

if (inserted.length === 0) {
  console.warn(
    'Dedupe matched an existing error_rate row for this 1h bucket — alert row not inserted, skipping Telegram delivery. Re-run after the bucket rolls over or DELETE the prior row.',
  );
  process.exit(0);
}

const telegram = createTelegramSender({ botToken: TELEGRAM_BOT_TOKEN });

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
    chatId: resolvedChatId,
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
console.info('  - Dashboard: Trade bot 1 → Recent Transactions (6 failed + 1 ok jupiter.swap rows)');
console.info('  - Dashboard: Alerts feed → new error_rate alert');
console.info('  - Telegram: chat should have a formatted "Error Rate" alert message');

process.exit(0);
