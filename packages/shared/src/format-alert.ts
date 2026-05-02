/**
 * Human-readable alert formatters.
 *
 * Single source of truth for rendering alert payloads. Consumed by the
 * dashboard (alerts list/detail), the Telegram sender, and any future
 * channel (Discord/Slack) that needs consistent copy.
 *
 * Two shapes:
 *   - formatAlertSummary  → one-line scannable headline ("Swap slipped 50% — 10× above 5%")
 *   - formatAlertDetails  → structured key/value rows for rich UIs
 */

import { SOLANA_SIGNATURE_RE } from './signature';
import type { AlertRuleName } from './types';

export interface AlertDetailRow {
  label: string;
  value: string;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function fmtPct(v: number | undefined): string {
  return v == null ? '—' : `${v}%`;
}

function fmtSol(lamports: number | undefined): string {
  if (lamports == null) return '—';
  const sol = lamports / LAMPORTS_PER_SOL;
  // Trim trailing zeros but keep at least 2 decimals for tiny values.
  const formatted = sol < 0.01 ? sol.toFixed(9) : sol.toFixed(6);
  return `${formatted.replace(/\.?0+$/, '')} SOL`;
}

function fmtMinutes(v: number | undefined): string {
  if (v == null) return '—';
  if (v < 60) return `${v} min`;
  const hours = Math.floor(v / 60);
  const mins = v % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/**
 * Curated, user-facing rule titles. Plain English, action-leaning where the
 * raw enum is jargon (`gas_spike` → "Fee Spike" since Solana doesn't use the
 * Ethereum "gas" term; `ghost_execution` → "Swap Never Landed" so non-technical
 * owners understand the impact, not the internal classification). Rule keys
 * absent from this map fall back to snake_case → Title Case via formatRuleTitle.
 */
const RULE_TITLES: Record<string, string> = {
  slippage_spike: 'Slippage Spike',
  gas_spike: 'Fee Spike',
  drawdown: 'Balance Drawdown',
  error_rate: 'High Error Rate',
  stale_agent: 'Bot Silent',
  decision_swap_mismatch: 'Decision/Swap Mismatch',
  stale_oracle: 'Stale Price Used',
  ghost_execution: 'Swap Never Landed',
  // Pseudo-rule emitted by POST /api/agents/:id/test-alert. Not part of
  // ALERT_RULE_NAMES (never persisted), but the formatters must handle it
  // because it travels through the same telegram/webhook senders that
  // every real alert uses.
  test_alert: 'Test Alert',
};

/**
 * Turn a machine rule name ("slippage_spike") into a human title
 * ("Slippage Spike"). Curated overrides in RULE_TITLES win; otherwise
 * falls back to snake_case → Title Case.
 */
export function formatRuleTitle(ruleName: string): string {
  const override = RULE_TITLES[ruleName];
  if (override) return override;
  return ruleName
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * One-line scannable summary of what triggered the alert.
 * Used as subtitle in the alert list and body line in Telegram.
 */
export function formatAlertSummary(
  ruleName: AlertRuleName | string,
  payload: Record<string, unknown>,
): string {
  switch (ruleName) {
    case 'slippage_spike': {
      const actual = num(payload, 'actualPct');
      const threshold = num(payload, 'thresholdPct');
      if (actual == null) return 'Swap slippage exceeded threshold';
      // When threshold is missing/zero we fall back to a single-clause
      // sentence — otherwise the previous template produced the dangling
      // "Swap slipped 5% threshold" with the connector word missing.
      if (!threshold || threshold <= 0) return `Swap slipped ${actual}% above threshold`;
      const ratio = actual / threshold;
      return `Swap slipped ${actual}% — ${ratio.toFixed(1)}× above ${threshold}% threshold`;
    }
    case 'gas_spike': {
      const ratio = num(payload, 'ratio');
      const fee = num(payload, 'feeLamports');
      const median = num(payload, 'medianFeeLamports');
      if (fee == null) return 'Transaction fee spiked above median';
      const ratioStr = ratio ? ` — ${ratio}× above median` : '';
      const medianStr = median != null ? ` (${fmtSol(median)})` : '';
      return `Fee ${fmtSol(fee)}${ratioStr}${medianStr}`;
    }
    case 'error_rate': {
      const rate = num(payload, 'ratePct');
      const failed = num(payload, 'failed');
      const total = num(payload, 'total');
      const window = num(payload, 'windowMinutes');
      if (rate == null) return 'Error rate exceeded threshold';
      const ratioStr = failed != null && total != null ? ` (${failed}/${total} tx` : '';
      const windowStr = window != null ? ` in last ${fmtMinutes(window)})` : ratioStr ? ')' : '';
      return `${rate}% failure rate${ratioStr}${windowStr}`;
    }
    case 'drawdown': {
      const dd = num(payload, 'drawdownPct');
      const delta = num(payload, 'totalDeltaSol');
      const window = num(payload, 'windowMinutes');
      const deltaStr = delta != null ? `${delta >= 0 ? '+' : ''}${delta} SOL` : '';
      const windowStr = window != null ? ` in ${fmtMinutes(window)}` : '';
      const ddStr = dd != null ? ` (${dd}% drawdown)` : '';
      if (!deltaStr) return `Balance drawdown${ddStr}`;
      return `${deltaStr}${windowStr}${ddStr}`;
    }
    case 'stale_agent': {
      const inactive = num(payload, 'inactiveMinutes');
      const threshold = num(payload, 'thresholdMinutes');
      if (inactive == null) {
        return str(payload, 'reason') ?? 'No transactions ever';
      }
      const thrStr = threshold != null ? ` (threshold: ${fmtMinutes(threshold)})` : '';
      return `Silent for ${fmtMinutes(inactive)}${thrStr}`;
    }
    case 'decision_swap_mismatch': {
      const decisionAction = str(payload, 'decisionAction');
      const swapSide = str(payload, 'swapSide');
      const decisionAmount = num(payload, 'decisionAmountSol');
      const swapAmount = num(payload, 'swapAmountSol');
      const issues = Array.isArray(payload.issues) ? (payload.issues as string[]) : [];
      if (issues.includes('action_flip') && decisionAction && swapSide) {
        return `Agent decided ${decisionAction.toUpperCase()} but executed ${swapSide.toUpperCase()}`;
      }
      if (issues.includes('amount_mismatch') && decisionAmount != null && swapAmount != null) {
        const delta = num(payload, 'amountDeltaPct');
        const deltaStr = delta != null ? ` (${delta.toFixed(1)}% off)` : '';
        return `Decided ${decisionAmount} SOL, executed ${swapAmount} SOL${deltaStr}`;
      }
      return 'Decision and on-chain swap diverged';
    }
    case 'stale_oracle': {
      const market = num(payload, 'marketPriceUsd');
      const decision = num(payload, 'decisionPriceUsd');
      const div = num(payload, 'divergencePct');
      if (market == null || decision == null) return 'Bot acted on a stale price';
      const divStr = div != null ? ` — market moved ${div.toFixed(2)}% since` : '';
      return `Bot used $${decision} but market is now $${market}${divStr}`;
    }
    case 'ghost_execution': {
      const count = num(payload, 'ghostCount');
      const oldest = num(payload, 'oldestAgeMinutes');
      if (count == null) return 'Bot announced a swap but it never landed on-chain';
      const oldestStr = oldest != null ? `, oldest ${fmtMinutes(oldest)} ago` : '';
      return count === 1
        ? `Bot announced 1 swap but it never landed on-chain${oldestStr}`
        : `Bot announced ${count} swaps but they never landed on-chain${oldestStr}`;
    }
    case 'test_alert':
      return 'If you can read this, alert delivery is working.';
    default:
      return formatRuleTitle(ruleName);
  }
}

/**
 * Structured key/value rows for rich rendering (dashboard expand, future
 * Discord/Slack embeds). Excludes fields already covered by the summary
 * to avoid visual duplication — keep this in sync with `formatAlertSummary`.
 */
export function formatAlertDetails(
  ruleName: AlertRuleName | string,
  payload: Record<string, unknown>,
): AlertDetailRow[] {
  switch (ruleName) {
    case 'slippage_spike':
      return [
        { label: 'Actual slippage', value: fmtPct(num(payload, 'actualPct')) },
        { label: 'Threshold', value: fmtPct(num(payload, 'thresholdPct')) },
      ];
    case 'gas_spike': {
      const ratio = num(payload, 'ratio');
      const thresholdMult = num(payload, 'thresholdMult');
      return [
        { label: 'Fee', value: fmtSol(num(payload, 'feeLamports')) },
        { label: 'Median fee', value: fmtSol(num(payload, 'medianFeeLamports')) },
        { label: 'Ratio', value: ratio == null ? '—' : `${ratio}×` },
        { label: 'Threshold', value: thresholdMult == null ? '—' : `${thresholdMult}×` },
      ];
    }
    case 'error_rate': {
      const failed = num(payload, 'failed');
      const total = num(payload, 'total');
      return [
        { label: 'Error rate', value: fmtPct(num(payload, 'ratePct')) },
        { label: 'Threshold', value: fmtPct(num(payload, 'thresholdPct')) },
        {
          label: 'Failed / total',
          value: failed != null && total != null ? `${failed} / ${total}` : '—',
        },
        { label: 'Window', value: fmtMinutes(num(payload, 'windowMinutes')) },
      ];
    }
    case 'drawdown': {
      const delta = num(payload, 'totalDeltaSol');
      return [
        { label: 'Drawdown', value: fmtPct(num(payload, 'drawdownPct')) },
        { label: 'Threshold', value: fmtPct(num(payload, 'thresholdPct')) },
        { label: 'Total delta', value: delta == null ? '—' : `${delta} SOL` },
        { label: 'Window', value: fmtMinutes(num(payload, 'windowMinutes')) },
      ];
    }
    case 'stale_agent': {
      const inactive = num(payload, 'inactiveMinutes');
      const threshold = num(payload, 'thresholdMinutes');
      const reason = str(payload, 'reason');
      if (inactive == null) {
        return [{ label: 'Reason', value: reason ?? 'no transactions ever' }];
      }
      return [
        { label: 'Inactive for', value: fmtMinutes(inactive) },
        { label: 'Threshold', value: fmtMinutes(threshold) },
      ];
    }
    case 'decision_swap_mismatch': {
      const decisionAction = str(payload, 'decisionAction');
      const swapSide = str(payload, 'swapSide');
      const decisionAmount = num(payload, 'decisionAmountSol');
      const swapAmount = num(payload, 'swapAmountSol');
      const delta = num(payload, 'amountDeltaPct');
      const issues = Array.isArray(payload.issues) ? (payload.issues as string[]) : [];
      return [
        { label: 'Decided action', value: decisionAction ?? '—' },
        { label: 'Executed side', value: swapSide ?? '—' },
        {
          label: 'Decided amount',
          value: decisionAmount != null ? `${decisionAmount} SOL` : '—',
        },
        { label: 'Executed amount', value: swapAmount != null ? `${swapAmount} SOL` : '—' },
        { label: 'Delta', value: delta != null ? `${delta.toFixed(2)}%` : '—' },
        { label: 'Issues', value: issues.length > 0 ? issues.join(', ') : '—' },
        { label: 'Threshold', value: fmtPct(num(payload, 'thresholdPct')) },
      ];
    }
    case 'stale_oracle': {
      const market = num(payload, 'marketPriceUsd');
      const decision = num(payload, 'decisionPriceUsd');
      return [
        { label: 'Market price', value: market != null ? `$${market}` : '—' },
        { label: 'Decision price', value: decision != null ? `$${decision}` : '—' },
        { label: 'Drift', value: fmtPct(num(payload, 'divergencePct')) },
        { label: 'Threshold', value: fmtPct(num(payload, 'thresholdPct')) },
      ];
    }
    case 'ghost_execution': {
      const count = num(payload, 'ghostCount');
      const age = num(payload, 'oldestAgeMinutes');
      return [
        { label: 'Stuck swap spans', value: count != null ? String(count) : '—' },
        { label: 'Oldest stuck for', value: fmtMinutes(age) },
        { label: 'Threshold', value: fmtMinutes(num(payload, 'thresholdMinutes')) },
        { label: 'Oldest signature', value: str(payload, 'oldestSignature') ?? '—' },
      ];
    }
    // The smoke-test payload (`isTest`, `source`) is plumbing-only metadata —
    // dumping it as bullet rows adds noise without telling the user anything
    // they don't already know from the title and impact line.
    case 'test_alert':
      return [];
    default:
      return Object.entries(payload)
        .filter(([k]) => k !== 'signature')
        .map(([k, v]) => ({
          label: k,
          value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
        }));
  }
}

/**
 * Plain-English explanation of WHAT THIS MEANS for the bot owner.
 * One sentence, no jargon. Rendered alongside the metric-heavy summary so
 * a non-technical owner can answer "why should I care?" without opening
 * the dashboard.
 */
export function formatAlertImpact(
  ruleName: AlertRuleName | string,
  _payload: Record<string, unknown>,
): string {
  switch (ruleName) {
    case 'slippage_spike':
      return "Your bot's swap executed at a worse price than its slippage limit allows. The trade likely lost more value than intended.";
    case 'gas_spike':
      return 'The bot paid an unusually high transaction fee. Repeat fees at this level will eat into PnL.';
    case 'error_rate':
      return 'A high share of recent transactions failed. The bot may be misconfigured or hitting on-chain errors.';
    case 'drawdown':
      return "The bot's wallet balance dropped sharply in a short window. This usually signals a losing strategy or a failure mode.";
    case 'stale_agent':
      return 'The bot has stopped sending transactions. It may have crashed, been paused, or run out of funds.';
    case 'decision_swap_mismatch':
      return "The bot's reasoning said one thing but the on-chain transaction did another. This is a serious integrity issue.";
    case 'stale_oracle':
      return 'The bot acted on a price that no longer reflects the market. Trades made on stale data are likely mispriced.';
    case 'ghost_execution':
      return 'The bot announced a swap in its reasoning but no matching transaction reached the chain. The trade was likely lost or never submitted.';
    case 'test_alert':
      return 'This is a smoke test triggered from your dashboard. No real anomaly was detected — no action needed.';
    default:
      return 'An anomaly was detected in your bot. Open the dashboard for details.';
  }
}

/**
 * 1–2 short, imperative next steps for the bot owner. Empty array means
 * "no canned guidance for this rule" and the channel should omit the
 * actions block entirely.
 */
export function formatAlertAction(
  ruleName: AlertRuleName | string,
  _payload: Record<string, unknown>,
): string[] {
  switch (ruleName) {
    case 'slippage_spike':
      return [
        'Open the dashboard and review this swap.',
        'Tighten the slippage cap or pause the bot if volatility is high.',
      ];
    case 'gas_spike':
      return [
        'Check current network congestion before more swaps.',
        "Review the bot's priority fee strategy.",
      ];
    case 'error_rate':
      return [
        'Open the dashboard and inspect the failed transactions.',
        'Consider pausing the bot until the cause is found.',
      ];
    case 'drawdown':
      return [
        'Open the dashboard and review recent activity.',
        'Pause the bot if the drop is unexpected.',
      ];
    case 'stale_agent':
      return [
        'Check that the bot process is still running.',
        'Verify wallet balance and RPC health.',
      ];
    case 'decision_swap_mismatch':
      return [
        'Open the trace in the dashboard to compare decision vs. transaction.',
        'Stop the bot until the cause is found.',
      ];
    case 'stale_oracle':
      return [
        "Verify the bot's oracle / price source is healthy.",
        'Review recent trades for mispricing losses.',
      ];
    case 'ghost_execution':
      return [
        "Check the bot's RPC logs for submission failures.",
        'Verify the wallet has SOL for fees.',
      ];
    default:
      return [];
  }
}

/**
 * Thin alias over the shared SOLANA_SIGNATURE_RE for the alerter's
 * "real tx vs demo seed" branching. Kept as a named helper so call sites
 * read intent-first rather than regex-first.
 */
export function isOnChainSignature(sig: string): boolean {
  return SOLANA_SIGNATURE_RE.test(sig);
}
