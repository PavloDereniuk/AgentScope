/**
 * Slippage-sandwich rule (post-MVP roadmap A.1, v0.4.0).
 *
 * Tx-triggered. Fires when a Jupiter swap's actual receive amount
 * (computed from `tokenDeltas`) lags the quoted amount embedded in the
 * instruction args (`parsedArgs.outAmount`) by more than the configured
 * threshold. This is the on-chain fingerprint of a sandwich attack: an
 * MEV bot front-ran the agent's tx, pushed the pool price against it,
 * and the route delivered the worst-acceptable fill at the swap's own
 * slippage tolerance.
 *
 * Phase 1 here is *evidence-only* — it flags suspect tx based on the
 * agent's own swap data, with no external lookups. Phase 2 augments
 * the rule with `apps/ingestion`'s slot-neighbour lookup to confirm a
 * front-runner is present, and escalates severity when matched.
 *
 * Why this is distinct from `slippage_spike`: that rule guards on the
 * *intent* (the swap's own `slippageBps` tolerance), so a swap with a
 * 1% cap can never trip it even if MEV took 0.99% of the pool. The
 * sandwich rule reads actual vs. quote, which is the only signal that
 * surfaces when the bot is operating *within* the tolerance band.
 */

import type { AlertSeverity, TokenDelta } from '@agentscope/shared';
import type { RuleResult, SlotNeighbourTx, TxRuleDef, TxSnapshot } from '../types';

/** Multiplier at which severity escalates from warning to critical. */
const CRITICAL_MULTIPLIER = 5;

/**
 * Jupiter v6 mainnet program id. Hard-coded rather than imported from the
 * parser package to keep the detector dependency-free (detector reads it
 * as a plain string from the neighbour fetcher's projection).
 */
const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function parseBigIntStrict(value: unknown): bigint | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Locate the positive token movement for the output mint. We require
 * positive because a sandwich-victim swap *receives* the output token;
 * a negative entry would mean the wallet sent the mint out (impossible
 * for a swap output). When no matching positive entry exists (e.g. a
 * wrap-and-close wSOL ATA that never showed up in pre/post balances)
 * the rule abstains rather than guessing.
 */
function findActualOutAmount(
  tokenDeltas: readonly TokenDelta[],
  outputMint: string,
): bigint | null {
  for (const d of tokenDeltas) {
    if (d.mint !== outputMint) continue;
    const value = parseBigIntStrict(d.delta);
    if (value === null) continue;
    if (value > 0n) return value;
  }
  return null;
}

/**
 * Surface the contract for the runner: when a sandwich is *evidence-suspect*
 * but not yet confirmed by neighbour lookup, expose just enough data so the
 * Phase 2 augmentation can decide whether to escalate. Internal to the rule
 * module; not exported from the package.
 */
interface SandwichEvidence {
  outputMint: string;
  quotedOutAmount: bigint;
  actualOutAmount: bigint;
  actualSlippagePct: number;
}

export function detectSandwichEvidence(transaction: TxSnapshot): SandwichEvidence | null {
  if (transaction.instructionName !== 'jupiter.swap') return null;
  const args = transaction.parsedArgs;
  if (!args) return null;

  const outputMint = args.outputMint;
  if (typeof outputMint !== 'string' || outputMint.length === 0) return null;

  const quotedOutAmount = parseBigIntStrict(args.outAmount);
  if (quotedOutAmount === null || quotedOutAmount <= 0n) return null;

  const actualOutAmount = findActualOutAmount(transaction.tokenDeltas, outputMint);
  if (actualOutAmount === null) return null;

  // Positive-slippage / break-even fills can never be sandwiches — the bot
  // would walk away with less value than it injected. Abstain instead of
  // logging zero-pct rows.
  if (actualOutAmount >= quotedOutAmount) return null;

  const diff = quotedOutAmount - actualOutAmount;
  // bps with BigInt math; integer math is enough for two-decimal accuracy.
  const slippageBps = Number((diff * 10000n) / quotedOutAmount);
  const actualSlippagePct = slippageBps / 100;

  return {
    outputMint,
    quotedOutAmount,
    actualOutAmount,
    actualSlippagePct,
  };
}

/**
 * Phase 2 — locate a same-slot front-runner candidate. A neighbour
 * confirms a sandwich when it (a) is a Jupiter v6 swap and (b) paid a
 * strictly higher priority fee than the victim. We compare on total
 * `feeLamports` rather than splitting base + priority because the
 * `getBlock` projection collapses them, and on Solana base fee is a
 * fixed 5000 lamports/sig — any positive delta is priority-fee driven.
 *
 * Failed neighbours are excluded: a front-runner that didn't land
 * couldn't have moved the pool. Self-matches (same signature) are
 * filtered defensively even though the fetcher should not return them.
 */
function findFrontRunner(
  neighbours: readonly SlotNeighbourTx[],
  ownSignature: string,
  ownFeeLamports: number,
): SlotNeighbourTx | null {
  for (const n of neighbours) {
    if (!n.success) continue;
    if (n.signature === ownSignature) continue;
    if (n.feeLamports <= ownFeeLamports) continue;
    if (!n.programIds.includes(JUPITER_V6_PROGRAM_ID)) continue;
    return n;
  }
  return null;
}

export const sandwichRule: TxRuleDef = {
  name: 'slippage_sandwich',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, defaults, fetchSlotNeighbours } = ctx;

    const evidence = detectSandwichEvidence(transaction);
    if (!evidence) return null;

    const thresholdPct =
      agent.alertRules.sandwichSlippagePctThreshold ?? defaults.sandwichSlippagePct;
    // Guard against misconfigured thresholds. A zero or negative threshold
    // would either match every swap or be semantically meaningless; either
    // way, abstain rather than emit alert storms.
    if (thresholdPct <= 0) return null;
    if (evidence.actualSlippagePct < thresholdPct) return null;

    let severity: AlertSeverity =
      evidence.actualSlippagePct >= thresholdPct * CRITICAL_MULTIPLIER ? 'critical' : 'warning';

    // Phase 2 augmentation: confirm with a same-slot front-runner. The
    // fetch is optional — when unavailable (tests, cron paths, RPC
    // errors) the rule degrades gracefully to evidence-only output.
    let frontRunner: SlotNeighbourTx | null = null;
    if (fetchSlotNeighbours) {
      try {
        const neighbours = await fetchSlotNeighbours(transaction.slot);
        frontRunner = findFrontRunner(neighbours, transaction.signature, transaction.feeLamports);
        // A confirmed front-runner escalates warning → critical. A swap
        // already at critical stays critical (the metric pegged severity
        // before the lookup; neighbour evidence cannot make it worse).
        if (frontRunner && severity === 'warning') severity = 'critical';
      } catch {
        // Defensive: keep behaviour identical to Phase 1 if the fetcher
        // throws or rejects. The dispatcher's own try/catch logs the
        // error; we should not propagate it into a missed alert.
        frontRunner = null;
      }
    }

    const payload: Record<string, unknown> = {
      actualSlippagePct: evidence.actualSlippagePct,
      thresholdPct,
      outputMint: evidence.outputMint,
      quotedOutAmount: evidence.quotedOutAmount.toString(),
      actualOutAmount: evidence.actualOutAmount.toString(),
      signature: transaction.signature,
      slot: transaction.slot,
      neighbourConfirmed: frontRunner !== null,
    };

    if (frontRunner) {
      payload.neighbourSignature = frontRunner.signature;
      payload.neighbourFeeLamports = frontRunner.feeLamports;
    }

    return {
      ruleName: 'slippage_sandwich',
      severity,
      payload,
      // Dedupe per signature: WS redeliveries / restarts must not duplicate
      // the alert. Distinct from `slippage:<sig>` (slippage_spike) so both
      // rules can fire on the same tx without colliding on the alerts
      // (agent_id, rule_name, dedupe_key) UNIQUE index.
      dedupeKey: `sandwich:${transaction.signature}`,
    };
  },
};
