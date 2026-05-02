/**
 * Stale oracle rule (Epic 17, post-MVP scope expansion 2026-05-02).
 *
 * Fires when an agent's MAKE_DECISION span uses a price that diverges
 * from the ANALYZE_MARKET span's observed price by more than the
 * configured percentage threshold within the same trace. The two spans
 * should agree — they are emitted milliseconds apart in the same cycle —
 * so any divergence indicates either a stale snapshot, an oracle source
 * mismatch, or active price manipulation.
 *
 * Tx-triggered: looks up reasoning spans correlated with the persisted
 * tx via reasoning_logs.tx_signature, then walks the trace by trace_id
 * to find ANALYZE_MARKET (market.price_usd) and MAKE_DECISION
 * (decision.price_usd). If either is missing, the rule no-ops.
 *
 * Severity: warning by default, escalates to critical at 5× threshold.
 * Default threshold: 1% — rule-based agents in the same trace should
 * never drift; LLM agents may legitimately drift slightly while sampling.
 */

import { reasoningLogs } from '@agentscope/db';
import type { SpanAttributes } from '@agentscope/shared';
import { eq } from 'drizzle-orm';
import type { RuleResult, TxRuleDef } from '../types';

const DEFAULT_PCT = 1;
const CRITICAL_MULTIPLIER = 5;

function readPriceUsd(attrs: SpanAttributes, key: string): number | null {
  const v = attrs[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

export const staleOracleRule: TxRuleDef = {
  name: 'stale_oracle',

  async evaluate(ctx): Promise<RuleResult | null> {
    const { transaction, agent, db } = ctx;
    if (transaction.instructionName !== 'jupiter.swap') return null;

    // Step 1: find any reasoning span linked to this signature (gives us trace_id).
    const linkedSpans = await db
      .select({ traceId: reasoningLogs.traceId })
      .from(reasoningLogs)
      .where(eq(reasoningLogs.txSignature, transaction.signature))
      .limit(1);

    const traceId = linkedSpans[0]?.traceId;
    if (!traceId) return null;

    // Step 2: pull all spans in the trace and read prices from siblings.
    const spans = await db
      .select({
        spanId: reasoningLogs.spanId,
        spanName: reasoningLogs.spanName,
        attributes: reasoningLogs.attributes,
      })
      .from(reasoningLogs)
      .where(eq(reasoningLogs.traceId, traceId));

    let marketPrice: number | null = null;
    let decisionPrice: number | null = null;
    let marketSpanId: string | null = null;
    let decisionSpanId: string | null = null;

    for (const span of spans) {
      const attrs = span.attributes as SpanAttributes;
      if (marketPrice == null) {
        const v = readPriceUsd(attrs, 'market.price_usd');
        if (v != null) {
          marketPrice = v;
          marketSpanId = span.spanId;
        }
      }
      if (decisionPrice == null) {
        const v = readPriceUsd(attrs, 'decision.price_usd');
        if (v != null) {
          decisionPrice = v;
          decisionSpanId = span.spanId;
        }
      }
    }

    if (marketPrice == null || decisionPrice == null) return null;

    const thresholdPct = agent.alertRules.staleOraclePctThreshold ?? DEFAULT_PCT;
    if (thresholdPct <= 0) return null;

    const divergencePct = Math.abs((decisionPrice - marketPrice) / marketPrice) * 100;
    if (divergencePct <= thresholdPct) return null;

    const severity = divergencePct >= thresholdPct * CRITICAL_MULTIPLIER ? 'critical' : 'warning';

    return {
      ruleName: 'stale_oracle',
      severity,
      payload: {
        signature: transaction.signature,
        traceId,
        marketPriceUsd: marketPrice,
        decisionPriceUsd: decisionPrice,
        divergencePct,
        thresholdPct,
        marketSpanId,
        decisionSpanId,
      },
      dedupeKey: `stale_oracle:${transaction.signature}`,
    };
  },
};
