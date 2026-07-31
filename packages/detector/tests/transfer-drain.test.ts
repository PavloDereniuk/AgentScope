/**
 * Integration tests for outbound_transfer_drain rule (post-MVP roadmap A.11).
 *
 * Same PGlite pattern as runaway / unknown_program: real migrations against an
 * in-memory Postgres, seeded tx rows with controlled timestamps, then assert
 * the aggregate-window logic.
 *
 * What makes this rule different from every other one: no single transaction
 * looks wrong. The signal only exists in the SUM over a window, measured
 * against the balance the wallet had when the window opened. The tests are
 * therefore built around balance reconstruction (`start = current − Σ solDelta`)
 * and around what counts as an "unknown" counterparty.
 */

import { agentTransactions, agents, users } from '@agentscope/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transferDrainRule } from '../src/rules/transfer-drain';
import type { BalanceFetcher, CronRuleContext } from '../src/types';
import { type TestDatabase, createTestDatabase } from './helpers/test-db';

const defaults = {
  slippagePct: 5,
  gasMult: 3,
  drawdownPct: 10,
  errorRatePct: 20,
  staleMinutes: 30,
  sandwichSlippagePct: 2,
  lowBalanceSol: 0.005,
  txRateMaxPerMin: 30,
  priorityFeeMult: 10,
  unknownProgramLookbackDays: 30,
  // 25% of the window-start balance leaving to unfamiliar addresses inside
  // 15 minutes ⇒ warning; 50% (2×) ⇒ critical.
  outboundDrainPct: 25,
};

const NOW = new Date('2026-07-20T12:00:00Z');
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const FEE_LAMPORTS = 5000;
const FEE_SOL = 0.000005;

/** A destination the agent has been paying since long before the window. */
const KNOWN_DEST = 'Known1111111111111111111111111111';

let testDb: TestDatabase;

/** 3 × 0.1 SOL to three fresh addresses inside the window. */
let drainerAgentId: string;
/** Same volume, but every transfer goes to a long-standing counterparty. */
let knownDestAgentId: string;
/** 2 × 0.3 SOL out of a 1 SOL window-start balance → 60% → critical. */
let criticalAgentId: string;
/** One 0.01 SOL transfer against a 10 SOL balance → 0.1% → noise. */
let smallAgentId: string;
/** Big transfers, but all older than the 15-minute window. */
let oldWindowAgentId: string;
/** Big transfers that never landed (success = false). */
let failedAgentId: string;
/** Big SOL outflow through a swap — no decodable destination. */
let swapAgentId: string;
/** Transfers back to the agent's own wallet. */
let selfAgentId: string;
/** Drain-shaped window, but zero history before it. */
let coldStartAgentId: string;
/** Transfer rows whose parsed_args are missing `to` / `lamports`. */
let malformedAgentId: string;
/** Received 1 SOL mid-window, then drained — start balance must net out. */
let inflowAgentId: string;

const WALLETS: Record<string, string> = {
  drainer: 'Wa11etDrainer11111111111111111111',
  known: 'Wa11etKnownDest111111111111111111',
  critical: 'Wa11etCritica111111111111111111111',
  small: 'Wa11etSma1111111111111111111111111',
  old: 'Wa11etO1dWindow11111111111111111',
  failed: 'Wa11etFai1ed1111111111111111111111',
  swap: 'Wa11etSwap111111111111111111111111',
  self: 'Wa11etSe1f111111111111111111111111',
  cold: 'Wa11etCo1dStart11111111111111111',
  malformed: 'Wa11etMa1formed11111111111111111',
  inflow: 'Wa11etInf1ow11111111111111111111',
};

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/** Nine-decimal string, matching the numeric(20,9) column. */
function sol(value: number): string {
  return value.toFixed(9);
}

interface TransferRow {
  agentId: string;
  wallet: string;
  signature: string;
  to: string | null;
  amountSol: number;
  at: string;
  success?: boolean;
  /** Override the args entirely — used by the malformed-payload cases. */
  args?: Record<string, unknown>;
}

/**
 * A persisted `system.transfer` row as `persistTx` would write it: primary
 * instruction args at the top level of `parsed_args`, plus the compact `_all`
 * outline. `sol_delta` carries the fee, exactly like the parser emits it.
 */
function transferRow(row: TransferRow) {
  const lamports = Math.round(row.amountSol * 1e9);
  const outbound = row.to !== row.wallet;
  return {
    agentId: row.agentId,
    signature: row.signature,
    slot: 100,
    blockTime: row.at,
    programId: SYSTEM_PROGRAM,
    instructionName: 'system.transfer',
    parsedArgs: row.args ?? {
      from: outbound ? row.wallet : KNOWN_DEST,
      to: row.to,
      lamports: String(lamports),
      _all: [{ index: 0, programId: SYSTEM_PROGRAM, name: 'system.transfer' }],
    },
    // Inbound transfers credit the wallet and cost it no fee (the sender pays).
    solDelta: outbound ? sol(-row.amountSol - FEE_SOL) : sol(row.amountSol),
    tokenDeltas: [],
    feeLamports: outbound ? FEE_LAMPORTS : 0,
    success: row.success ?? true,
  };
}

/** A plain swap row — establishes history without establishing a counterparty. */
function swapRow(agentId: string, signature: string, at: string, solDelta = '0') {
  return {
    agentId,
    signature,
    slot: 100,
    blockTime: at,
    programId: JUPITER_PROGRAM,
    instructionName: 'jupiter.swap',
    parsedArgs: {
      _all: [{ index: 0, programId: JUPITER_PROGRAM, name: 'jupiter.swap' }],
    },
    solDelta,
    tokenDeltas: [],
    feeLamports: FEE_LAMPORTS,
    success: true,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const [user] = await testDb.db
    .insert(users)
    .values({ privyDid: 'did:privy:transfer-drain-test' })
    .returning();
  if (!user) throw new Error('seed user failed');
  const userId = user.id;

  async function makeAgent(name: string, token: string, wallet: string): Promise<string> {
    const [a] = await testDb.db
      .insert(agents)
      .values({
        userId,
        walletPubkey: wallet,
        name,
        framework: 'custom',
        agentType: 'other',
        ingestToken: token,
      })
      .returning();
    if (!a) throw new Error(`seed agent ${name} failed`);
    return a.id;
  }

  drainerAgentId = await makeAgent('Drainer', 'tok_drain', WALLETS.drainer as string);
  knownDestAgentId = await makeAgent('Known dest', 'tok_known', WALLETS.known as string);
  criticalAgentId = await makeAgent('Critical', 'tok_crit', WALLETS.critical as string);
  smallAgentId = await makeAgent('Small', 'tok_small', WALLETS.small as string);
  oldWindowAgentId = await makeAgent('Old window', 'tok_old', WALLETS.old as string);
  failedAgentId = await makeAgent('Failed', 'tok_failed', WALLETS.failed as string);
  swapAgentId = await makeAgent('Swap', 'tok_swap', WALLETS.swap as string);
  selfAgentId = await makeAgent('Self', 'tok_self', WALLETS.self as string);
  coldStartAgentId = await makeAgent('Cold start', 'tok_cold', WALLETS.cold as string);
  malformedAgentId = await makeAgent('Malformed', 'tok_malformed', WALLETS.malformed as string);
  inflowAgentId = await makeAgent('Inflow', 'tok_inflow', WALLETS.inflow as string);

  const rows: ReturnType<typeof transferRow | typeof swapRow>[] = [];

  // ── Drainer: 3 × 0.1 SOL to three fresh addresses, 10/6/2 min ago.
  // Balance now 0.4 → window start 0.700015 → 42.86% drained → warning.
  rows.push(swapRow(drainerAgentId, 'sig_drain_hist', isoDaysAgo(5)));
  rows.push(
    transferRow({
      agentId: drainerAgentId,
      wallet: WALLETS.drainer as string,
      signature: 'sig_drain_old_known',
      to: KNOWN_DEST,
      amountSol: 0.05,
      at: isoDaysAgo(5),
    }),
  );
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: drainerAgentId,
        wallet: WALLETS.drainer as string,
        signature: `sig_drain_${i}`,
        to: `Fresh${i}1111111111111111111111111111`,
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Known dest: identical volume, but the destination is a counterparty the
  // agent has been paying for weeks.
  rows.push(swapRow(knownDestAgentId, 'sig_known_hist', isoDaysAgo(5)));
  rows.push(
    transferRow({
      agentId: knownDestAgentId,
      wallet: WALLETS.known as string,
      signature: 'sig_known_old',
      to: KNOWN_DEST,
      amountSol: 0.05,
      at: isoDaysAgo(5),
    }),
  );
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: knownDestAgentId,
        wallet: WALLETS.known as string,
        signature: `sig_known_${i}`,
        to: KNOWN_DEST,
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Critical: 2 × 0.3 SOL out, balance now 0.4 → start 1.00001 → 60%.
  rows.push(swapRow(criticalAgentId, 'sig_crit_hist', isoDaysAgo(5)));
  for (const [i, minutes] of [9, 3].entries()) {
    rows.push(
      transferRow({
        agentId: criticalAgentId,
        wallet: WALLETS.critical as string,
        signature: `sig_crit_${i}`,
        to: 'FreshCrit11111111111111111111111',
        amountSol: 0.3,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Small: 0.01 SOL against a ~10 SOL wallet → 0.1%.
  rows.push(swapRow(smallAgentId, 'sig_small_hist', isoDaysAgo(5)));
  rows.push(
    transferRow({
      agentId: smallAgentId,
      wallet: WALLETS.small as string,
      signature: 'sig_small_0',
      to: 'FreshSmal111111111111111111111111',
      amountSol: 0.01,
      at: isoMinutesAgo(5),
    }),
  );

  // ── Old window: same drain shape, 45 minutes ago.
  rows.push(swapRow(oldWindowAgentId, 'sig_old_hist', isoDaysAgo(5)));
  for (const [i, minutes] of [45, 40].entries()) {
    rows.push(
      transferRow({
        agentId: oldWindowAgentId,
        wallet: WALLETS.old as string,
        signature: `sig_old_${i}`,
        to: 'FreshO1d111111111111111111111111',
        amountSol: 0.15,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Failed: the transfers never landed.
  rows.push(swapRow(failedAgentId, 'sig_failed_hist', isoDaysAgo(5)));
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: failedAgentId,
        wallet: WALLETS.failed as string,
        signature: `sig_failed_${i}`,
        to: 'FreshFai1ed11111111111111111111',
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
        success: false,
      }),
    );
  }

  // ── Swap: 0.5 SOL leaves the wallet, but into a Jupiter route.
  rows.push(swapRow(swapAgentId, 'sig_swap_hist', isoDaysAgo(5)));
  rows.push(swapRow(swapAgentId, 'sig_swap_out', isoMinutesAgo(5), sol(-0.5)));

  // ── Self: agent shuffling SOL to its own wallet.
  rows.push(swapRow(selfAgentId, 'sig_self_hist', isoDaysAgo(5)));
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: selfAgentId,
        wallet: WALLETS.self as string,
        signature: `sig_self_${i}`,
        to: WALLETS.self as string,
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Cold start: drain-shaped window, nothing before it.
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: coldStartAgentId,
        wallet: WALLETS.cold as string,
        signature: `sig_cold_${i}`,
        to: `FreshCo1d${i}111111111111111111111`,
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  // ── Malformed: rows that look like transfers but carry no usable args.
  rows.push(swapRow(malformedAgentId, 'sig_malformed_hist', isoDaysAgo(5)));
  rows.push(
    transferRow({
      agentId: malformedAgentId,
      wallet: WALLETS.malformed as string,
      signature: 'sig_malformed_no_to',
      to: null,
      amountSol: 0.1,
      at: isoMinutesAgo(8),
      args: { from: WALLETS.malformed, lamports: '100000000' },
    }),
  );
  rows.push(
    transferRow({
      agentId: malformedAgentId,
      wallet: WALLETS.malformed as string,
      signature: 'sig_malformed_no_lamports',
      to: null,
      amountSol: 0.1,
      at: isoMinutesAgo(7),
      args: { from: WALLETS.malformed, to: 'FreshMa1formed111111111111111111' },
    }),
  );
  rows.push(
    transferRow({
      agentId: malformedAgentId,
      wallet: WALLETS.malformed as string,
      signature: 'sig_malformed_bad_lamports',
      to: null,
      amountSol: 0.1,
      at: isoMinutesAgo(6),
      args: {
        from: WALLETS.malformed,
        to: 'FreshMa1formed111111111111111111',
        lamports: 'not-a-number',
      },
    }),
  );

  // ── Inflow: +1 SOL received mid-window, then 3 × 0.1 SOL drained out.
  // Balance now 1.4 → Σ solDelta = +0.699985 → start 0.700015 → 42.86%.
  // Ignoring the inflow would read as 17.6% and stay silent.
  rows.push(swapRow(inflowAgentId, 'sig_inflow_hist', isoDaysAgo(5)));
  rows.push(
    transferRow({
      agentId: inflowAgentId,
      wallet: WALLETS.inflow as string,
      signature: 'sig_inflow_in',
      to: WALLETS.inflow as string,
      amountSol: 1,
      at: isoMinutesAgo(12),
    }),
  );
  for (const [i, minutes] of [10, 6, 2].entries()) {
    rows.push(
      transferRow({
        agentId: inflowAgentId,
        wallet: WALLETS.inflow as string,
        signature: `sig_inflow_${i}`,
        to: `FreshInf1ow${i}11111111111111111111`,
        amountSol: 0.1,
        at: isoMinutesAgo(minutes),
      }),
    );
  }

  await testDb.db.insert(agentTransactions).values(rows);
});

afterAll(async () => {
  await testDb.close();
});

interface CtxOptions {
  balanceSol?: number | null;
  thresholdPct?: number;
  /** Drop `fetchAgentBalance` entirely (tx-runner path). */
  noFetcher?: boolean;
  /** Drop `walletPubkey` from the agent snapshot. */
  noWallet?: boolean;
  /** Make the fetcher reject (RPC failure). */
  throws?: boolean;
  now?: Date;
}

function makeCtx(agentId: string, wallet: string, opts: CtxOptions = {}): CronRuleContext {
  const fetcher: BalanceFetcher = async () => {
    if (opts.throws) throw new Error('rpc down');
    return opts.balanceSol ?? null;
  };
  return {
    agent: {
      id: agentId,
      // `!== undefined` so an explicit 0 reaches the misconfig guard instead of
      // silently falling back to the default.
      alertRules:
        opts.thresholdPct !== undefined ? { outboundDrainPctThreshold: opts.thresholdPct } : {},
      ...(opts.noWallet ? {} : { walletPubkey: wallet }),
    },
    defaults,
    db: testDb.db,
    now: opts.now ?? NOW,
    ...(opts.noFetcher ? {} : { fetchAgentBalance: fetcher }),
  };
}

describe('outbound_transfer_drain rule', () => {
  it('fires when small transfers to fresh addresses add up past the threshold', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4 }),
    );
    expect(result).not.toBeNull();
    expect(result?.ruleName).toBe('outbound_transfer_drain');
    expect(result?.severity).toBe('warning');
    expect(result?.payload).toMatchObject({
      thresholdPct: 25,
      windowMinutes: 15,
      transferCount: 3,
      destinationCount: 3,
    });
    expect(result?.payload.drainSol).toBeCloseTo(0.3, 9);
    // 0.3 / 0.700015 = 42.86%
    expect(result?.payload.drainPct as number).toBeCloseTo(42.86, 1);
    expect(result?.payload.windowStartBalanceSol as number).toBeCloseTo(0.700015, 6);
  });

  it('lists the destinations that received the funds, largest first', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4 }),
    );
    const destinations = result?.payload.destinations as { address: string; sol: number }[];
    expect(destinations).toHaveLength(3);
    for (const d of destinations) {
      expect(d.address).toMatch(/^Fresh/);
      expect(d.sol).toBeCloseTo(0.1, 9);
    }
  });

  it('stays silent when every transfer goes to a long-standing counterparty', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(knownDestAgentId, WALLETS.known as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('escalates to critical at 2× the threshold (60% of the window-start balance)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(criticalAgentId, WALLETS.critical as string, { balanceSol: 0.4 }),
    );
    expect(result?.severity).toBe('critical');
    expect(result?.payload.drainPct as number).toBeCloseTo(60, 1);
  });

  it('ignores a transfer that is a rounding error against the balance', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(smallAgentId, WALLETS.small as string, { balanceSol: 9.99 }),
    );
    expect(result).toBeNull();
  });

  it('ignores transfers older than the 15-minute window', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(oldWindowAgentId, WALLETS.old as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('ignores failed transfers (nothing left the wallet but the fee)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(failedAgentId, WALLETS.failed as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('ignores SOL that leaves through a swap (no counterparty to judge)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(swapAgentId, WALLETS.swap as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('ignores inbound transfers (the destination is the agent wallet itself)', async () => {
    // Money arriving is persisted as `system.transfer` too, with `to` = the
    // agent wallet. Without the self-check every top-up would read as a drain.
    const result = await transferDrainRule.evaluate(
      makeCtx(selfAgentId, WALLETS.self as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('abstains on an agent with no history before the window (cold start)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(coldStartAgentId, WALLETS.cold as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('skips transfer rows whose parsed args carry no usable destination or amount', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(malformedAgentId, WALLETS.malformed as string, { balanceSol: 0.4 }),
    );
    expect(result).toBeNull();
  });

  it('nets mid-window inflows out of the reconstructed start balance', async () => {
    // Balance 1.4 now, but 1 SOL of that arrived inside the window. Measuring
    // the drain against 1.4 (or against 1.4 + outflow) would under-report it.
    const result = await transferDrainRule.evaluate(
      makeCtx(inflowAgentId, WALLETS.inflow as string, { balanceSol: 1.4 }),
    );
    expect(result).not.toBeNull();
    expect(result?.payload.windowStartBalanceSol as number).toBeCloseTo(0.700015, 6);
    expect(result?.payload.drainPct as number).toBeCloseTo(42.86, 1);
  });

  it('honours a per-agent threshold override upward', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4, thresholdPct: 60 }),
    );
    expect(result).toBeNull();
  });

  it('honours a per-agent threshold override downward, including escalation', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4, thresholdPct: 10 }),
    );
    // 42.86% ≥ 2 × 10% → critical.
    expect(result?.severity).toBe('critical');
    expect(result?.payload.thresholdPct).toBe(10);
  });

  it('returns null when the threshold is non-positive (misconfig guard)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4, thresholdPct: 0 }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the balance fetcher is unwired', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { noFetcher: true }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the agent snapshot has no wallet pubkey', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4, noWallet: true }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the balance is unknown (RPC returned null)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: null }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the balance fetcher throws (RPC failure is not evidence)', async () => {
    const result = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { throws: true }),
    );
    expect(result).toBeNull();
  });

  it('abstains when the reconstructed start balance is non-positive', async () => {
    // Balance reads 0 now, yet the window shows a net +0.7 SOL inflow — the
    // reconstruction lands below zero, which means the inputs disagree (missed
    // tx, stale balance). A percentage off that denominator is meaningless.
    const result = await transferDrainRule.evaluate(
      makeCtx(inflowAgentId, WALLETS.inflow as string, { balanceSol: 0 }),
    );
    expect(result).toBeNull();
  });

  it('emits a stable 15-minute-bucket dedupe key', async () => {
    const a = await transferDrainRule.evaluate(
      makeCtx(drainerAgentId, WALLETS.drainer as string, { balanceSol: 0.4 }),
    );
    const WINDOW_MS = 15 * 60 * 1000;
    expect(a?.dedupeKey).toBe(
      `outbound_transfer_drain:${drainerAgentId}:${Math.floor(NOW.getTime() / WINDOW_MS)}`,
    );
    // Crossing into the next bucket re-fires on purpose — an ongoing drain
    // must keep paging the owner, not go quiet after the first alert.
    const nextBucket = `outbound_transfer_drain:${drainerAgentId}:${Math.floor((NOW.getTime() + WINDOW_MS) / WINDOW_MS)}`;
    expect(a?.dedupeKey).not.toBe(nextBucket);
  });
});
