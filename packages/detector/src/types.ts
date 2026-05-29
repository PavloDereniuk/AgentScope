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
import type {
  AlertRuleName,
  AlertRuleThresholds,
  AlertSeverity,
  TokenDelta,
} from '@agentscope/shared';

// ── Snapshots (minimal data rules need) ──────────────────────────────────────

/** Agent identity + per-agent threshold overrides. */
export interface AgentSnapshot {
  id: string;
  alertRules: AlertRuleThresholds;
  /**
   * Solana wallet pubkey (base58). Optional because only balance-aware
   * rules (`low_balance`) need it; existing rules read DB rows keyed by
   * `id` and ignore this field. Rules that need it must abstain (return
   * null) when absent rather than throw.
   */
  walletPubkey?: string;
}

/** Parsed transaction fields relevant to detection. */
export interface TxSnapshot {
  signature: string;
  /** Solana slot — needed by slot-neighbour rules (sandwich detector A.1 Phase 2). */
  slot: number;
  instructionName: string | null;
  parsedArgs: Record<string, unknown> | null;
  solDelta: string;
  /**
   * Net SPL token movements for this tx, owner-centric. Required by
   * rules that compare actual on-chain receive amount to instruction
   * intent (e.g. `slippage_sandwich`).
   */
  tokenDeltas: readonly TokenDelta[];
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
  /**
   * Actual slippage % (quoted vs received) above which a Jupiter swap is
   * flagged as a sandwich-attack candidate. Distinct from `slippagePct`
   * which gates on the *intent* (instruction's `slippageBps` tolerance);
   * this one gates on what the chain actually returned.
   */
  sandwichSlippagePct: number;
  /**
   * Warning threshold for `low_balance` rule, in SOL. Critical fires at
   * one-fifth of this value. Default 0.005 SOL warning → 0.001 SOL critical.
   */
  lowBalanceSol: number;
  /**
   * Tx-per-minute cap (mean rate over a 5-minute sliding window) above which
   * the `tx_rate_anomaly` rule fires. Default 30/min — picked as the rate
   * where a single agent is doing one tx every 2s, well above any plausible
   * non-loop strategy (HFT-grade bots set higher per-agent overrides).
   */
  txRateMaxPerMin: number;
}

// ── Slot-neighbour lookup (A.1 Phase 2) ──────────────────────────────────────

/**
 * Minimal projection of a transaction sharing the same Solana slot as
 * the agent's swap. Used by `slippage_sandwich` to confirm a front-runner
 * (a higher-priority-fee swap on the same DEX program landed beside the
 * agent's tx).
 */
export interface SlotNeighbourTx {
  signature: string;
  feeLamports: number;
  programIds: readonly string[];
  success: boolean;
}

/**
 * Lookup function injected by the ingestion layer. Returns the
 * neighbour transactions for a given slot, or an empty array when
 * the block is unavailable / errored. Detector rules treat absence
 * of evidence as "no confirmation" — they never throw when the
 * fetcher fails.
 */
export type NeighbourFetcher = (slot: number) => Promise<readonly SlotNeighbourTx[]>;

// ── Wallet-balance lookup (A.2) ──────────────────────────────────────────────

/**
 * Lookup function injected by the ingestion layer. Returns the agent
 * wallet's current SOL balance as a decimal number, or `null` when the
 * balance is unknown (RPC failure, wallet not found). Rules treat `null`
 * as "no signal" — they never alert on a missing reading. Implementations
 * SHOULD cache + coalesce so multiple rules sharing a wallet pay one RPC.
 */
export type BalanceFetcher = (walletPubkey: string) => Promise<number | null>;

// ── Rule contexts ────────────────────────────────────────────────────────────

/** Shared across both tx and cron evaluation. */
interface BaseRuleContext {
  agent: AgentSnapshot;
  defaults: DefaultThresholds;
  db: Database;
  now: Date;
  /**
   * Optional slot-neighbour lookup. When wired (production), rules that
   * compare against same-slot tx may use it. When absent (tests, cron
   * paths), rules fall back to their evidence-only behaviour.
   */
  fetchSlotNeighbours?: NeighbourFetcher;
  /**
   * Optional wallet-balance lookup. When wired (production cron), the
   * `low_balance` rule queries it via `agent.walletPubkey`. When absent
   * (tests, tx-runner), balance-aware rules abstain rather than throw.
   */
  fetchAgentBalance?: BalanceFetcher;
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
