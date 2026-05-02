/**
 * Decision/swap mismatch rule (Epic 17, post-MVP scope expansion 2026-05-02).
 *
 * Cross-checks the MAKE_DECISION reasoning span against the actual swap
 * that landed on-chain. Fires when the agent "said one thing, did another":
 *
 *   - decision.action ("buy"/"sell") differs from the swap's direction
 *     inferred from input/output mints (or the executor's swap.side attr).
 *   - decision.amount_sol differs from the executed amount by more than
 *     the configured percentage threshold (default 5%).
 *
 * Without this rule the existing detector cannot catch agent-kit bugs that
 * silently substitute amounts (e.g. unit mismatch lamports vs SOL, prompt
 * drift, wrong token routing). Slippage rule only checks tolerance, not
 * intent fidelity.
 *
 * Severity: warning by default, escalates to critical when:
 *   - the action itself flipped (buy → sell or vice versa), OR
 *   - the amount mismatch exceeds 5× the threshold.
 *
 * The rule is tx-triggered: it requires a persisted `jupiter.swap` row
 * and looks up the matching reasoning trace via `reasoning_logs.tx_signature`.
 * If no reasoning span exists for the tx, the rule no-ops — the agent
 * may not be instrumented yet, which is not an anomaly.
 */

import { reasoningLogs } from '@agentscope/db';
import type { SpanAttributes } from '@agentscope/shared';
import { eq } from 'drizzle-orm';
import type { RuleResult, TxRuleDef } from '../types';

const DEFAULT_MISMATCH_PCT = 5;
const CRITICAL_MULTIPLIER = 5;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface DecisionAttrs {
  action: 'buy' | 'sell' | null;
  amountSol: number | null;
  spanId: string;
}

function readDecisionAttrs(attrs: SpanAttributes): DecisionAttrs | null {
  const action = attrs['decision.action'];
  const amount = attrs['decision.amount_sol'];
  const normalizedAction =
    action === 'buy' || action === 'sell' ? (action as 'buy' | 'sell') : null;
  const normalizedAmount = typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  if (!normalizedAction && normalizedAmount == null) return null;
  return {
    action: normalizedAction,
    amountSol: normalizedAmount,
    spanId: '',
  };
}

/**
 * Infer the swap side from parsed instruction args. Jupiter v6 emits
 * `inputMint` / `outputMint` strings; "buy" SOL = wSOL is the OUTPUT,
 * "sell" SOL = wSOL is the INPUT. Returns null if mints are missing or
 * neither side is wSOL — the rule cannot decide and should no-op.
 */
function inferSwapSide(args: Record<string, unknown>): 'buy' | 'sell' | null {
  const input = typeof args.inputMint === 'string' ? args.inputMint : null;
  const output = typeof args.outputMint === 'string' ? args.outputMint : null;
  if (input === WSOL_MINT) return 'sell';
  if (output === WSOL_MINT) return 'buy';
  return null;
}

/**
 * Effective SOL amount sent to / received from the swap, in whole SOL.
 * Uses inAmount when selling SOL, outAmount when buying SOL. Falls back
 * to lamports/1e9 when amounts are missing decimals — Jupiter's parser
 * stores raw integer strings.
 */
function effectiveSwapSol(args: Record<string, unknown>, side: 'buy' | 'sell'): number | null {
  const raw = side === 'sell' ? args.inAmount : args.outAmount;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const lamports = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  if (!Number.isFinite(lamports) || lamports < 0) return null;
  return lamports / 1_000_000_000;
}

export const decisionSwapMismatchRule: TxRuleDef = {
  name: 'decision_swap_mismatch',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, db } = ctx;
    if (transaction.instructionName !== 'jupiter.swap') return null;

    const args = transaction.parsedArgs;
    if (!args) return null;

    const swapSide = inferSwapSide(args);
    if (!swapSide) return null;

    const swapSol = effectiveSwapSol(args, swapSide);

    // Pull all spans for traces correlated with this signature. A trace
    // typically has 3 spans (analyze / decide / execute) so the in-memory
    // scan is cheap. We compare against the FIRST decision span found —
    // multi-decision traces are rare for rule-based agents.
    const spans = await db
      .select({
        spanId: reasoningLogs.spanId,
        attributes: reasoningLogs.attributes,
      })
      .from(reasoningLogs)
      .where(eq(reasoningLogs.txSignature, transaction.signature));

    if (spans.length === 0) return null;

    let decision: DecisionAttrs | null = null;
    for (const span of spans) {
      const parsed = readDecisionAttrs(span.attributes as SpanAttributes);
      if (parsed) {
        decision = { ...parsed, spanId: span.spanId };
        break;
      }
    }
    if (!decision) return null;

    const thresholdPct = agent.alertRules.decisionMismatchPctThreshold ?? DEFAULT_MISMATCH_PCT;
    if (thresholdPct <= 0) return null;

    const issues: string[] = [];
    let critical = false;

    if (decision.action && decision.action !== swapSide) {
      issues.push('action_flip');
      critical = true;
    }

    let amountDeltaPct: number | null = null;
    if (decision.amountSol != null && swapSol != null && decision.amountSol > 0) {
      amountDeltaPct = Math.abs((swapSol - decision.amountSol) / decision.amountSol) * 100;
      if (amountDeltaPct > thresholdPct) {
        issues.push('amount_mismatch');
        if (amountDeltaPct >= thresholdPct * CRITICAL_MULTIPLIER) critical = true;
      }
    }

    if (issues.length === 0) return null;

    return {
      ruleName: 'decision_swap_mismatch',
      severity: critical ? 'critical' : 'warning',
      payload: {
        signature: transaction.signature,
        decisionSpanId: decision.spanId,
        decisionAction: decision.action,
        decisionAmountSol: decision.amountSol,
        swapSide,
        swapAmountSol: swapSol,
        amountDeltaPct,
        thresholdPct,
        issues,
      },
      dedupeKey: `decision_swap_mismatch:${transaction.signature}`,
    };
  },
};
