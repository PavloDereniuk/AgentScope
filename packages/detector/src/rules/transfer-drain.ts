/**
 * Outbound transfer drain rule (A.11).
 *
 * Fires when SOL leaving the wallet for *unfamiliar* addresses inside a
 * 15-minute window adds up to more than a configured share of the balance the
 * wallet held when the window opened (default 25%, critical at 2×).
 *
 * Every other rule in the detector judges one transaction. This one exists
 * because a patient drainer never sends a transaction worth judging: twenty
 * transfers of 2% each look like ordinary operation one at a time, and only
 * the sum says the wallet is being emptied. `unknown_program_interaction`
 * (A.9) catches the loud version — first contact with a strange program while
 * funds move — and this catches the quiet one, where the program is
 * `SystemProgram` and nothing is strange except the total.
 *
 * Four design choices worth knowing:
 *
 *  1. **Window-start balance is reconstructed, not stored.** There is no
 *     historical balance table, so the rule computes
 *     `start = current − Σ sol_delta(window)`. Summing the signed deltas (not
 *     just the outflows) is what makes a mid-window top-up net out: a wallet
 *     that received 1 SOL and then sent 0.3 must be measured against what it
 *     actually held at the start, otherwise a funded agent looks safe while it
 *     drains. Non-positive results mean the inputs disagree (missed tx, stale
 *     balance) — the rule abstains rather than divide by a fiction.
 *  2. **SOL only, `system.transfer` only.** Persistence keeps decoded args for
 *     the primary instruction alone (E.5 storage diet), so a destination
 *     address is available exactly when the tx's primary instruction is a
 *     System-Program transfer. SOL that leaves through a swap has no
 *     counterparty to judge, and SPL transfers are not decoded at all yet —
 *     the token leg lands with A.10's SPL Token parser.
 *  3. **Familiar = paid before the window opened,** over a fixed 30-day
 *     history. Transfers inside the window never make their own destination
 *     familiar, or the first hop of a drain would whitelist all the rest.
 *  4. **Cold-start abstain,** matching A.9 and `priority_fee_spike`: an agent
 *     with no history before the window has no counterparty baseline, so every
 *     address it pays would read as fresh.
 *
 * Cost: one indexed query per agent per cron cycle in the common case (no
 * transfers in the last 15 minutes → return). The counterparty lookup, the
 * cold-start probe, the delta sum and the balance read only run once there is
 * something unfamiliar to report, and the balance read hits the cache the cron
 * primes for every wallet at the top of the cycle (E.1).
 */

import { agentTransactions } from '@agentscope/db';
import { type SQL, and, eq, gte, lt, sql } from 'drizzle-orm';
import { LAMPORTS_PER_SOL, lamportsToSol, solStringToLamports } from '../lamports';
import type { CronRuleDef, RuleResult } from '../types';

const WINDOW_MINUTES = 15;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const MS_PER_DAY = 86_400_000;

/**
 * How far back a payment counts as establishing a counterparty. Fixed rather
 * than configurable: the tunable users actually reason about is "how much of
 * my wallet may leave", and a second knob measured in days would mostly
 * generate support questions. 30 days matches the default first-contact window
 * of `unknown_program_interaction` so the two security rules agree on what
 * "familiar" means.
 */
const COUNTERPARTY_LOOKBACK_DAYS = 30;

/** Same escalation slope as `tx_rate_anomaly` / `error_rate`. */
const CRITICAL_MULTIPLIER = 2;

/** Only the largest destinations make the payload — the rest is a tail. */
const MAX_LISTED_DESTINATIONS = 5;

/**
 * The only instruction name that carries a decodable SOL destination. The
 * seed variant (`system.transfer_with_seed`) is deliberately excluded: the
 * parser labels it but decodes no args, so there is nothing to attribute.
 */
const TRANSFER_INSTRUCTION = 'system.transfer';

/** `parsed_args ->> key` — the decoded primary-instruction args (E.5). */
function arg(key: string): SQL<string | null> {
  return sql<string | null>`${agentTransactions.parsedArgs} ->> ${key}`;
}

/**
 * Parse a lamport field written by the System-Program parser. Rejects anything
 * that is not a plain unsigned integer string — `parsed_args` is untyped jsonb
 * and a malformed row must drop out of the sum, not poison it.
 */
function parseLamports(raw: string | null): bigint | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > 0n ? value : null;
}

export const transferDrainRule: CronRuleDef = {
  name: 'outbound_transfer_drain',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { agent, defaults, db, now, fetchAgentBalance } = ctx;

    const thresholdPct = agent.alertRules.outboundDrainPctThreshold ?? defaults.outboundDrainPct;
    // 0 / negative would fire on any outbound transfer whatsoever — a misconfig,
    // not a detector setting. Abstain instead of storming.
    if (thresholdPct <= 0) return null;
    // Both are required to reconstruct a denominator. Absent in the tx-runner
    // path and in tests; the rule does nothing rather than guess.
    if (!fetchAgentBalance || !agent.walletPubkey) return null;

    const wallet = agent.walletPubkey;
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();
    const historyStart = new Date(
      now.getTime() - COUNTERPARTY_LOOKBACK_DAYS * MS_PER_DAY,
    ).toISOString();

    // Failed transfers moved nothing but the fee, so they cannot drain — but
    // they still count toward the delta sum further down, which is why the
    // success filter lives here and not in the window predicate.
    const windowTransfers = await db
      .select({ destination: arg('to'), lamports: arg('lamports') })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          gte(agentTransactions.blockTime, since),
          eq(agentTransactions.instructionName, TRANSFER_INSTRUCTION),
          eq(agentTransactions.success, true),
        ),
      );
    if (windowTransfers.length === 0) return null;

    // Money arriving is persisted as `system.transfer` too, with the agent's
    // own wallet as `to`. Dropping those here is what keeps a top-up from
    // reading as a drain.
    const sentTo = new Map<string, bigint>();
    let transferCount = 0;
    for (const row of windowTransfers) {
      const destination = row.destination;
      const lamports = parseLamports(row.lamports);
      if (!destination || destination === wallet || lamports === null) continue;
      sentTo.set(destination, (sentTo.get(destination) ?? 0n) + lamports);
      transferCount += 1;
    }
    if (sentTo.size === 0) return null;

    // Familiar counterparties: paid at least once between the history start and
    // the moment the window opened. `lt(since)` is load-bearing — including the
    // window would let a drain's first hop whitelist every hop after it.
    const priorRows = await db
      .selectDistinct({ destination: arg('to') })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          eq(agentTransactions.instructionName, TRANSFER_INSTRUCTION),
          gte(agentTransactions.blockTime, historyStart),
          lt(agentTransactions.blockTime, since),
        ),
      );
    const familiar = new Set(
      priorRows.map((row) => row.destination).filter((d): d is string => d !== null),
    );

    let drainLamports = 0n;
    const unfamiliar: { address: string; lamports: bigint }[] = [];
    for (const [address, lamports] of sentTo) {
      if (familiar.has(address)) continue;
      drainLamports += lamports;
      unfamiliar.push({ address, lamports });
    }
    if (unfamiliar.length === 0) return null;

    // Cold start: without history before the window there is no baseline, so
    // every address the agent pays is "new" by construction. Checked only once
    // there is something to report, keeping the common path at one query.
    const [anyHistory] = await db
      .select({ id: agentTransactions.id })
      .from(agentTransactions)
      .where(
        and(
          eq(agentTransactions.agentId, agent.id),
          gte(agentTransactions.blockTime, historyStart),
          lt(agentTransactions.blockTime, since),
        ),
      )
      .limit(1);
    if (!anyHistory) return null;

    let balanceSol: number | null;
    try {
      balanceSol = await fetchAgentBalance(wallet);
    } catch {
      // An RPC failure is not evidence of a drain. Same stance as low_balance.
      return null;
    }
    if (balanceSol == null) return null;

    // Signed sum over *every* tx in the window, failures included — their fees
    // left the wallet too, and the reconstruction has to account for them.
    const [netRow] = await db
      .select({ net: sql<string>`coalesce(sum(${agentTransactions.solDelta}), 0)::text` })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, agent.id), gte(agentTransactions.blockTime, since)));

    const currentLamports = BigInt(Math.round(balanceSol * Number(LAMPORTS_PER_SOL)));
    const netLamports = solStringToLamports(netRow?.net ?? '0');
    const startLamports = currentLamports - netLamports;
    if (startLamports <= 0n) return null;

    const drainPct = (Number(drainLamports) / Number(startLamports)) * 100;
    if (drainPct <= thresholdPct) return null;

    unfamiliar.sort((a, b) => (b.lamports > a.lamports ? 1 : b.lamports < a.lamports ? -1 : 0));

    return {
      ruleName: 'outbound_transfer_drain',
      severity: drainPct >= thresholdPct * CRITICAL_MULTIPLIER ? 'critical' : 'warning',
      payload: {
        drainSol: lamportsToSol(drainLamports),
        drainPct: Math.round(drainPct * 100) / 100,
        thresholdPct,
        windowMinutes: WINDOW_MINUTES,
        transferCount,
        destinationCount: unfamiliar.length,
        destinations: unfamiliar
          .slice(0, MAX_LISTED_DESTINATIONS)
          .map((d) => ({ address: d.address, sol: lamportsToSol(d.lamports) })),
        windowStartBalanceSol: lamportsToSol(startLamports),
        currentBalanceSol: balanceSol,
        counterpartyLookbackDays: COUNTERPARTY_LOOKBACK_DAYS,
      },
      // 15-min-bucket dedupe, same shape as tx_rate_anomaly: one alert per
      // window instead of one per 60s cycle, and a fresh alert once the window
      // rolls over — an ongoing drain must keep paging, not go quiet.
      dedupeKey: `outbound_transfer_drain:${agent.id}:${Math.floor(now.getTime() / WINDOW_MS)}`,
    };
  },
};
