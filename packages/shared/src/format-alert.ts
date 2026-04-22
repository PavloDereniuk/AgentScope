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
 * Turn a machine rule name ("slippage_spike") into a human title
 * ("Slippage Spike"). Safe fallback for unknown rules.
 */
export function formatRuleTitle(ruleName: string): string {
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
      const ratio = threshold && threshold > 0 ? actual / threshold : null;
      const ratioStr = ratio ? ` — ${ratio.toFixed(1)}× above ${threshold}%` : '';
      return `Swap slipped ${actual}%${ratioStr} threshold`;
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
 * Thin alias over the shared SOLANA_SIGNATURE_RE for the alerter's
 * "real tx vs demo seed" branching. Kept as a named helper so call sites
 * read intent-first rather than regex-first.
 */
export function isOnChainSignature(sig: string): boolean {
  return SOLANA_SIGNATURE_RE.test(sig);
}
