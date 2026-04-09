/**
 * Detector type definitions (task 5.1).
 *
 * Two evaluation contexts:
 *   - **Tx-triggered** (slippage, gas): fires after each persisted tx.
 *   - **Cron-triggered** (drawdown, error_rate, stale): fires on a
 *     periodic timer against each active agent.
 *
 * Each rule returns `RuleResult | null` — null means "nothing to report".
 */

import type { Database } from '@agentscope/db';
import type { AlertRuleName, AlertRuleThresholds, AlertSeverity } from '@agentscope/shared';

// ── Snapshots (minimal data rules need) ──────────────────────────────────────

/** Agent identity + per-agent threshold overrides. */
export interface AgentSnapshot {
  id: string;
  alertRules: AlertRuleThresholds;
}

/** Parsed transaction fields relevant to detection. */
export interface TxSnapshot {
  signature: string;
  instructionName: string | null;
  parsedArgs: Record<string, unknown> | null;
  solDelta: string;
  feeLamports: number;
  success: boolean;
  blockTime: string;
}

// ── Default thresholds (from env / config) ───────────────────────────────────

export interface DefaultThresholds {
  /** Max acceptable slippage % for Jupiter swaps. */
  slippagePct: number;
  /** Fee multiplier over 24h rolling median. */
  gasMult: number;
  /** Max 1h P&L drawdown %. */
  drawdownPct: number;
  /** Max failed tx ratio % in 1h window. */
  errorRatePct: number;
  /** Minutes of inactivity before stale alert. */
  staleMinutes: number;
}

// ── Rule contexts ────────────────────────────────────────────────────────────

/** Shared across both tx and cron evaluation. */
interface BaseRuleContext {
  agent: AgentSnapshot;
  defaults: DefaultThresholds;
  db: Database;
  now: Date;
}

/** Context for rules that evaluate a single new transaction. */
export interface TxRuleContext extends BaseRuleContext {
  transaction: TxSnapshot;
}

/** Context for rules that run on a periodic timer (no specific tx). */
export type CronRuleContext = BaseRuleContext;

// ── Rule result ──────────────────────────────────────────────────────────────

/** What a rule returns when it fires. Null means "no anomaly detected". */
export interface RuleResult {
  ruleName: AlertRuleName;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  /** Optional cooldown key — prevents duplicate alerts within a window. */
  dedupeKey?: string;
}

// ── Rule definitions ─────────────────────────────────────────────────────────

export interface TxRuleDef {
  name: AlertRuleName;
  evaluate: (ctx: TxRuleContext) => Promise<RuleResult | null>;
}

export interface CronRuleDef {
  name: AlertRuleName;
  evaluate: (ctx: CronRuleContext) => Promise<RuleResult | null>;
}
