/**
 * Demo agent seeder (C.0b).
 *
 * Inserts synthetic Jupiter swap transactions, OTel reasoning spans, and
 * occasional alerts for the public demo agent so /share/:id always shows
 * live-looking data without a real running agent.
 *
 * Enabled when DEMO_AGENT_ID env var is set. On first start (agent has no
 * transactions) seeds 7 days of history so the page is not empty on first
 * visit. Then runs every DEMO_SEED_INTERVAL_MS (default 4 h) to keep the
 * 24-hour KPIs non-zero.
 */

import { randomBytes } from 'node:crypto';
import { type Database, agentTransactions, agents, alerts, reasoningLogs } from '@agentscope/db';
import { eq, sql } from 'drizzle-orm';

// ── Logger interface (structurally compatible with pino.Logger) ───────────────

interface SeederLogger {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_SEED_INTERVAL_MS = 4 * 60 * 60 * 1000;

const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
} as const;

// Base58 alphabet for fake Solana signatures
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Approximate mainnet slot for a given Date (400 ms/slot, ~340 M as of 2026-06)
const BASE_SLOT = 340_000_000;
const BASE_TIME_MS = new Date('2026-06-12T00:00:00Z').getTime();

// ── Low-level helpers ─────────────────────────────────────────────────────────

function fakeSig(): string {
  const buf = randomBytes(64);
  return Array.from(
    { length: 88 },
    (_, i) => BASE58[(buf[i % 64] ?? 0) % BASE58.length] ?? '1',
  ).join('');
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function dateToSlot(date: Date): number {
  return BASE_SLOT + Math.floor((date.getTime() - BASE_TIME_MS) / 400);
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ── Synthetic data builders ───────────────────────────────────────────────────

type SwapDir = 'SOL_TO_USDC' | 'USDC_TO_SOL' | 'SOL_TO_BONK' | 'SOL_TO_JUP';

interface BuiltTx {
  row: {
    agentId: string;
    signature: string;
    slot: number;
    blockTime: string;
    programId: string;
    instructionName: string;
    parsedArgs: Record<string, unknown>;
    solDelta: string;
    tokenDeltas: Array<Record<string, unknown>>;
    feeLamports: number;
    success: boolean;
    rawLogs: string[];
  };
  sig: string;
  slippagePct: number;
}

function buildTx(agentId: string, at: Date, dir: SwapDir): BuiltTx {
  const solPrice = randFloat(130, 165);
  const sig = fakeSig();
  const slot = dateToSlot(at);
  const success = Math.random() > 0.08;
  const feeLamports = randInt(4_500, 8_000);
  const slippagePct = randFloat(0.05, success ? 2.1 : 4.8);
  const slippageBps = randInt(30, 100);
  let inputMint: string;
  let outputMint: string;
  let inAmount: number;
  let outAmount: number;
  let solDelta: string;
  let instructionName: string;

  if (dir === 'SOL_TO_USDC') {
    const solAmt = randFloat(0.5, 3.0);
    inputMint = MINTS.SOL;
    outputMint = MINTS.USDC;
    inAmount = Math.floor(solAmt * 1e9);
    outAmount = Math.floor(solAmt * solPrice * 1e6 * (1 - slippagePct / 100));
    solDelta = (-(solAmt + feeLamports / 1e9)).toFixed(9);
    instructionName = 'route';
  } else if (dir === 'USDC_TO_SOL') {
    const usdcAmt = randFloat(50, 400);
    inputMint = MINTS.USDC;
    outputMint = MINTS.SOL;
    inAmount = Math.floor(usdcAmt * 1e6);
    const solOut = (usdcAmt / solPrice) * (1 - slippagePct / 100);
    outAmount = Math.floor(solOut * 1e9);
    solDelta = (solOut - feeLamports / 1e9).toFixed(9);
    instructionName = 'sharedAccountsRoute';
  } else if (dir === 'SOL_TO_BONK') {
    const solAmt = randFloat(0.1, 0.8);
    inputMint = MINTS.SOL;
    outputMint = MINTS.BONK;
    inAmount = Math.floor(solAmt * 1e9);
    outAmount = Math.floor(((solAmt * solPrice) / 0.000002) * (1 - slippagePct / 100));
    solDelta = (-(solAmt + feeLamports / 1e9)).toFixed(9);
    instructionName = 'route';
  } else {
    const solAmt = randFloat(0.2, 1.5);
    inputMint = MINTS.SOL;
    outputMint = MINTS.JUP;
    inAmount = Math.floor(solAmt * 1e9);
    outAmount = Math.floor(((solAmt * solPrice) / 0.75) * (1 - slippagePct / 100));
    solDelta = (-(solAmt + feeLamports / 1e9)).toFixed(9);
    instructionName = 'route';
  }

  return {
    row: {
      agentId,
      signature: sig,
      slot,
      blockTime: at.toISOString(),
      programId: JUP_PROGRAM,
      instructionName,
      parsedArgs: {
        protocol: 'jupiter_v6',
        instructionName,
        inputMint,
        outputMint,
        inAmount,
        outAmount,
        slippageBps,
        platformFeeBps: 0,
        _all: [{ index: 0, programId: JUP_PROGRAM, name: instructionName }],
      },
      solDelta,
      tokenDeltas: [],
      feeLamports,
      success,
      rawLogs: [],
    },
    sig,
    slippagePct,
  };
}

// 3-span OTel reasoning trace: oracle → slippage eval → execution decision
function buildSpans(agentId: string, sig: string, at: Date, slippagePct: number) {
  const trace = hex(16);
  const rootId = hex(8);
  const evalId = hex(8);
  const execId = hex(8);
  const solPrice = randFloat(130, 165);
  const confidence = randFloat(0.71, 0.97);
  const decision = slippagePct < 2.5 ? 'execute_swap' : 'abort_high_slippage';

  return [
    {
      agentId,
      traceId: trace,
      spanId: rootId,
      parentSpanId: null as string | null,
      spanName: 'price_oracle_check',
      startTime: new Date(at.getTime() - 3_200).toISOString(),
      endTime: new Date(at.getTime() - 2_100).toISOString(),
      attributes: {
        'reasoning.step': 'price_oracle_check',
        'sol.price_usd': Number(solPrice.toFixed(2)),
        'oracle.source': 'pyth_on_chain',
        'oracle.confidence': 0.998,
        'llm.model': 'gpt-4o',
      } as Record<string, unknown>,
      txSignature: sig,
    },
    {
      agentId,
      traceId: trace,
      spanId: evalId,
      parentSpanId: rootId as string | null,
      spanName: 'slippage_evaluation',
      startTime: new Date(at.getTime() - 2_100).toISOString(),
      endTime: new Date(at.getTime() - 900).toISOString(),
      attributes: {
        'reasoning.step': 'slippage_evaluation',
        'slippage.estimated_pct': Number(slippagePct.toFixed(4)),
        'slippage.threshold_pct': 2.5,
        'slippage.acceptable': slippagePct < 2.5,
        'route.hops': randInt(1, 3),
        'pool.liquidity_usd': randInt(500_000, 8_000_000),
      } as Record<string, unknown>,
      txSignature: sig,
    },
    {
      agentId,
      traceId: trace,
      spanId: execId,
      parentSpanId: rootId as string | null,
      spanName: 'swap_execution_decision',
      startTime: new Date(at.getTime() - 900).toISOString(),
      endTime: new Date(at.getTime() - 100).toISOString(),
      attributes: {
        'reasoning.step': 'swap_execution_decision',
        decision,
        confidence: Number(confidence.toFixed(3)),
        'market.condition': confidence > 0.85 ? 'favorable' : 'neutral',
        'tx.signature': sig,
      } as Record<string, unknown>,
      txSignature: sig,
    },
  ];
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedBatch(
  db: Database,
  agentId: string,
  batchAnchor: Date,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const at = new Date(batchAnchor.getTime() - i * randInt(8, 25) * 60_000);
    const dirIndex = i % 4;
    const dir: SwapDir =
      dirIndex === 1
        ? 'USDC_TO_SOL'
        : dirIndex === 2
          ? 'SOL_TO_BONK'
          : dirIndex === 3
            ? 'SOL_TO_JUP'
            : 'SOL_TO_USDC';
    const { row, sig, slippagePct } = buildTx(agentId, at, dir);
    const spans = buildSpans(agentId, sig, at, slippagePct);

    await db.insert(agentTransactions).values(row).onConflictDoNothing();
    await db.insert(reasoningLogs).values(spans).onConflictDoNothing();

    // Slippage-spike alert when estimated slippage exceeds threshold
    if (slippagePct > 2.5) {
      const dayKey = at.toISOString().slice(0, 10);
      await db
        .insert(alerts)
        .values({
          agentId,
          ruleName: 'slippage_spike',
          severity: slippagePct > 4.0 ? 'critical' : 'warning',
          payload: {
            slippagePct: Number(slippagePct.toFixed(4)),
            threshold: 2.5,
            signature: sig,
          } as Record<string, unknown>,
          dedupeKey: `demo:slippage:${dayKey}`,
        })
        .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] });
    }
  }
}

async function seedHistory(db: Database, agentId: string, logger: SeederLogger): Promise<void> {
  const [row] = await db
    .select({ cnt: sql<number>`cast(count(*) as int)` })
    .from(agentTransactions)
    .where(eq(agentTransactions.agentId, agentId));

  if ((row?.cnt ?? 0) > 0) {
    logger.info({ agentId }, 'demo seeder: history exists, skipping initial seed');
    return;
  }

  logger.info({ agentId }, 'demo seeder: seeding 7-day history');
  const now = Date.now();
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const anchor = new Date(now - daysAgo * 24 * 3_600_000);
    await seedBatch(db, agentId, anchor, randInt(4, 9));
  }

  // decision_swap_mismatch alert 3 days back for variety
  const threeDaysAgo = new Date(now - 3 * 24 * 3_600_000);
  await db
    .insert(alerts)
    .values({
      agentId,
      ruleName: 'decision_swap_mismatch',
      severity: 'warning',
      payload: {
        expected_action: 'buy',
        actual_action: 'sell',
        confidence: 0.58,
        reasoning_trace_id: hex(16),
      } as Record<string, unknown>,
      dedupeKey: `demo:mismatch:${threeDaysAgo.toISOString().slice(0, 10)}`,
    })
    .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] });

  logger.info({ agentId }, 'demo seeder: 7-day history seeded');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DemoSeederDeps {
  db: Database;
  agentId: string;
  logger: SeederLogger;
  /** Override for tests. Default: 4 hours. */
  intervalMs?: number;
}

async function runCycle(deps: DemoSeederDeps): Promise<void> {
  const { db, agentId, logger } = deps;
  const now = new Date();
  await seedBatch(db, agentId, now, randInt(3, 5));
  await db
    .update(agents)
    .set({ status: 'live', lastSeenAt: now.toISOString() })
    .where(eq(agents.id, agentId));
  logger.info({ agentId }, 'demo seeder: cycle complete');
}

export function startDemoSeeder(deps: DemoSeederDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEMO_SEED_INTERVAL_MS;

  // Seed history then run the first regular cycle right away
  seedHistory(deps.db, deps.agentId, deps.logger)
    .then(() => runCycle(deps))
    .catch((err: unknown) => deps.logger.error({ err }, 'demo seeder: initial seed failed'));

  const timer = setInterval(() => {
    runCycle(deps).catch((err: unknown) => deps.logger.error({ err }, 'demo seeder: cycle failed'));
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
