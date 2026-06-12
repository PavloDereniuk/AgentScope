/**
 * Demo agent seeder (C.0b).
 *
 * Inserts synthetic transactions, OTel reasoning spans, and occasional
 * alerts for the public demo agent. Realistic mix: ~40% Jupiter swaps,
 * ~45% SOL transfers, ~15% token transfers — small amounts, variable gaps.
 *
 * Enabled when DEMO_AGENT_ID env var is set. When DEMO_SEED_RESET=true is
 * also set, wipes existing demo data before seeding (one-time reset).
 * Runs every 4 h to keep 24-h KPIs non-zero.
 */

import { randomBytes } from 'node:crypto';
import { type Database, agentTransactions, agents, alerts, reasoningLogs } from '@agentscope/db';
import { eq, sql } from 'drizzle-orm';

interface SeederLogger {
  info: (obj: Record<string, unknown> | string, msg?: string) => void;
  error: (obj: Record<string, unknown> | string, msg?: string) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_SEED_INTERVAL_MS = 4 * 60 * 60 * 1000;

const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
} as const;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE_SLOT = 340_000_000;
const BASE_TIME_MS = new Date('2026-06-12T00:00:00Z').getTime();

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Transaction builders ──────────────────────────────────────────────────────

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
  isSwap: boolean;
}

function buildJupiterSwap(agentId: string, at: Date): BuiltTx {
  const sig = fakeSig();
  const solPrice = randFloat(130, 165);
  const feeLamports = randInt(4_500, 55_000);
  const success = Math.random() > 0.06;
  const slippagePct = randFloat(0.03, success ? 1.8 : 4.2);
  const slippageBps = randInt(30, 100);

  // Realistic small amounts: 0.005–0.12 SOL per swap
  const r = Math.random();
  let inputMint: string;
  let outputMint: string;
  let inAmount: number;
  let outAmount: number;
  let solDelta: string;
  let instructionName: string;

  if (r < 0.5) {
    // SOL → USDC
    const solAmt = randFloat(0.005, 0.12);
    inputMint = MINTS.SOL;
    outputMint = MINTS.USDC;
    inAmount = Math.floor(solAmt * 1e9);
    outAmount = Math.floor(solAmt * solPrice * 1e6 * (1 - slippagePct / 100));
    solDelta = (-(solAmt + feeLamports / 1e9)).toFixed(9);
    instructionName = 'route';
  } else if (r < 0.8) {
    // USDC → SOL
    const usdcAmt = randFloat(2, 18);
    inputMint = MINTS.USDC;
    outputMint = MINTS.SOL;
    inAmount = Math.floor(usdcAmt * 1e6);
    const solOut = (usdcAmt / solPrice) * (1 - slippagePct / 100);
    outAmount = Math.floor(solOut * 1e9);
    solDelta = (solOut - feeLamports / 1e9).toFixed(9);
    instructionName = 'sharedAccountsRoute';
  } else {
    // SOL → BONK/JUP
    const solAmt = randFloat(0.003, 0.05);
    inputMint = MINTS.SOL;
    outputMint = Math.random() > 0.5 ? MINTS.BONK : MINTS.JUP;
    inAmount = Math.floor(solAmt * 1e9);
    outAmount = Math.floor(
      ((solAmt * solPrice) / (outputMint === MINTS.BONK ? 0.000002 : 0.75)) *
        (1 - slippagePct / 100),
    );
    solDelta = (-(solAmt + feeLamports / 1e9)).toFixed(9);
    instructionName = 'route';
  }

  return {
    row: {
      agentId,
      signature: sig,
      slot: dateToSlot(at),
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
    isSwap: true,
  };
}

function buildSolTransfer(agentId: string, at: Date): BuiltTx {
  const sig = fakeSig();
  const feeLamports = 5_000;
  const lamports = randInt(1_000, 40_000_000); // 0.000001–0.04 SOL
  const solAmt = lamports / 1e9;
  const isSend = Math.random() > 0.35;
  const success = Math.random() > 0.03;
  const solDelta = isSend
    ? (-(solAmt + feeLamports / 1e9)).toFixed(9)
    : (solAmt - feeLamports / 1e9).toFixed(9);

  return {
    row: {
      agentId,
      signature: sig,
      slot: dateToSlot(at),
      blockTime: at.toISOString(),
      programId: SYSTEM_PROGRAM,
      instructionName: 'transfer',
      parsedArgs: {
        protocol: 'system_program',
        instructionName: 'transfer',
        lamports,
      },
      solDelta,
      tokenDeltas: [],
      feeLamports,
      success,
      rawLogs: [],
    },
    sig,
    slippagePct: 0,
    isSwap: false,
  };
}

function buildTokenTransfer(agentId: string, at: Date): BuiltTx {
  const sig = fakeSig();
  const feeLamports = 5_000;
  // Token transfers don't move SOL (only fee)
  const solDelta = (-(feeLamports / 1e9)).toFixed(9);

  return {
    row: {
      agentId,
      signature: sig,
      slot: dateToSlot(at),
      blockTime: at.toISOString(),
      programId: TOKEN_PROGRAM,
      instructionName: 'transferChecked',
      parsedArgs: {
        protocol: 'token_program',
        instructionName: 'transferChecked',
        mint: Math.random() > 0.5 ? MINTS.USDC : MINTS.BONK,
      },
      solDelta,
      tokenDeltas: [],
      feeLamports,
      success: Math.random() > 0.02,
      rawLogs: [],
    },
    sig,
    slippagePct: 0,
    isSwap: false,
  };
}

function pickTx(agentId: string, at: Date): BuiltTx {
  const r = Math.random();
  if (r < 0.4) return buildJupiterSwap(agentId, at);
  if (r < 0.85) return buildSolTransfer(agentId, at);
  return buildTokenTransfer(agentId, at);
}

// 3-span OTel trace — only generated for Jupiter swaps
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
        'pool.liquidity_usd': randInt(200_000, 5_000_000),
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
  anchor: Date,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    // Irregular gaps: 1–35 min between transactions
    const at = new Date(anchor.getTime() - i * randInt(1, 35) * 60_000);
    const built = pickTx(agentId, at);

    await db.insert(agentTransactions).values(built.row).onConflictDoNothing();

    // Reasoning spans only for Jupiter swaps
    if (built.isSwap) {
      const spans = buildSpans(agentId, built.sig, at, built.slippagePct);
      await db.insert(reasoningLogs).values(spans).onConflictDoNothing();

      if (built.slippagePct > 2.5) {
        const dayKey = at.toISOString().slice(0, 10);
        await db
          .insert(alerts)
          .values({
            agentId,
            ruleName: 'slippage_spike',
            severity: built.slippagePct > 4.0 ? 'critical' : 'warning',
            payload: {
              slippagePct: Number(built.slippagePct.toFixed(4)),
              threshold: 2.5,
              signature: built.sig,
            } as Record<string, unknown>,
            dedupeKey: `demo:slippage:${dayKey}`,
          })
          .onConflictDoNothing({ target: [alerts.agentId, alerts.ruleName, alerts.dedupeKey] });
      }
    }
  }
}

async function resetDemoData(db: Database, agentId: string, logger: SeederLogger): Promise<void> {
  logger.info({ agentId }, 'demo seeder: resetting existing demo data');
  // Delete in dependency order (reasoning_logs and alerts reference agent_id,
  // agent_transactions has partitioned cascade). No FK between logs and txs.
  await db.delete(reasoningLogs).where(eq(reasoningLogs.agentId, agentId));
  await db.delete(alerts).where(eq(alerts.agentId, agentId));
  await db.delete(agentTransactions).where(eq(agentTransactions.agentId, agentId));
  logger.info({ agentId }, 'demo seeder: reset complete');
}

async function seedHistory(
  db: Database,
  agentId: string,
  logger: SeederLogger,
  forceReset: boolean,
): Promise<void> {
  if (forceReset) {
    await resetDemoData(db, agentId, logger);
  } else {
    const [row] = await db
      .select({ cnt: sql<number>`cast(count(*) as int)` })
      .from(agentTransactions)
      .where(eq(agentTransactions.agentId, agentId));
    if ((row?.cnt ?? 0) > 0) {
      logger.info({ agentId }, 'demo seeder: history exists, skipping');
      return;
    }
  }

  logger.info({ agentId }, 'demo seeder: seeding 7-day history');
  const now = Date.now();
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const anchor = new Date(now - daysAgo * 24 * 3_600_000);
    // More activity on recent days: 6–18 tx
    const count = daysAgo <= 1 ? randInt(10, 18) : randInt(6, 14);
    await seedBatch(db, agentId, anchor, count);
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
  /** Wipe existing demo data before seeding. One-time reset via env var. */
  reset?: boolean;
  intervalMs?: number;
}

async function runCycle(deps: DemoSeederDeps): Promise<void> {
  const { db, agentId, logger } = deps;
  const now = new Date();
  await seedBatch(db, agentId, now, randInt(3, 6));
  await db
    .update(agents)
    .set({ status: 'live', lastSeenAt: now.toISOString() })
    .where(eq(agents.id, agentId));
  logger.info({ agentId }, 'demo seeder: cycle complete');
}

export function startDemoSeeder(deps: DemoSeederDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEMO_SEED_INTERVAL_MS;

  seedHistory(deps.db, deps.agentId, deps.logger, deps.reset ?? false)
    .then(() => runCycle(deps))
    .catch((err: unknown) => deps.logger.error({ err }, 'demo seeder: initial seed failed'));

  const timer = setInterval(() => {
    runCycle(deps).catch((err: unknown) => deps.logger.error({ err }, 'demo seeder: cycle failed'));
  }, intervalMs);

  return { stop: () => clearInterval(timer) };
}
