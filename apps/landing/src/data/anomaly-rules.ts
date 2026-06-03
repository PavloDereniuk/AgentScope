/**
 * Single source of truth for the anomaly-rule list rendered across the
 * landing site (Hero count, Features F.04 body + tag, Quickstart checklist).
 *
 * Keep in sync with `packages/detector/src/rules/*` and the canonical
 * `ALERT_RULE_NAMES` / `RULE_TITLES` in `packages/shared/src/types.ts` +
 * `format-alert.ts`. Labels here are the dev-facing short form (matching the
 * landing voice), NOT the humanised owner-facing titles used in alerts.
 *
 * When a new rule lands in the detector, append its label here once — every
 * landing surface derives its count and list from this array, so the three
 * places can no longer drift apart.
 */
export const ANOMALY_RULES = [
  'slippage spike',
  'gas spike',
  'error rate',
  'drawdown',
  'stale agent',
  'decision↔swap mismatch',
  'stale oracle',
  'ghost execution',
  'MEV sandwich',
  'low balance',
  'runaway loop',
] as const;

export const ANOMALY_RULE_COUNT = ANOMALY_RULES.length;
