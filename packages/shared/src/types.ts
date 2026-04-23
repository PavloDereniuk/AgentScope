/**
 * AgentScope shared domain types.
 * Single source of truth for entities crossing package boundaries.
 * All Zod schemas in `./schemas.ts` MUST stay in sync via z.infer.
 */

// ─── Enums ────────────────────────────────────────────────────────────────────

export const AGENT_FRAMEWORKS = ['elizaos', 'agent-kit', 'custom'] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

export const AGENT_TYPES = ['trader', 'yield', 'nft', 'other'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_STATUSES = ['live', 'stale', 'failed'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_RULE_NAMES = [
  'slippage_spike',
  'gas_spike',
  'drawdown',
  'error_rate',
  'stale_agent',
] as const;
export type AlertRuleName = (typeof ALERT_RULE_NAMES)[number];

export const DELIVERY_CHANNELS = ['telegram', 'webhook', 'discord', 'slack'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ─── Branded primitives ───────────────────────────────────────────────────────

import type { Brand } from './brand';

/** Solana base58 wallet pubkey (32-byte). */
export type SolanaPubkey = Brand<string, 'SolanaPubkey'>;

/** Solana transaction signature (base58, 64-byte). */
export type SolanaSignature = Brand<string, 'SolanaSignature'>;

/** UUID v4 string. */
export type UUID = Brand<string, 'UUID'>;

/** Privy DID (e.g. "did:privy:..."). */
export type PrivyDID = Brand<string, 'PrivyDID'>;

/** ISO-8601 timestamp string. */
export type ISOTimestamp = Brand<string, 'ISOTimestamp'>;

// ─── User ─────────────────────────────────────────────────────────────────────

export interface User {
  id: UUID;
  privyDid: PrivyDID;
  email: string | null;
  createdAt: ISOTimestamp;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

/**
 * Per-agent override for default detector thresholds.
 * Any field omitted falls back to env-configured global default.
 *
 * Optional fields use `T | undefined` explicitly to align with Zod's
 * `.optional()` output under `exactOptionalPropertyTypes: true`.
 */
export interface AlertRuleThresholds {
  slippagePctThreshold?: number | undefined;
  gasMultThreshold?: number | undefined;
  drawdownPctThreshold?: number | undefined;
  errorRatePctThreshold?: number | undefined;
  staleMinutesThreshold?: number | undefined;
}

export interface Agent {
  id: UUID;
  userId: UUID;
  walletPubkey: SolanaPubkey;
  name: string;
  framework: AgentFramework;
  agentType: AgentType;
  tags: readonly string[];
  webhookUrl: string | null;
  /** Per-agent Telegram chat_id for alert delivery. Null → fall back to env default. */
  telegramChatId: string | null;
  alertRules: AlertRuleThresholds;
  /** Opaque token used by the agent's OTel exporter to authenticate /v1/traces. */
  ingestToken: string;
  status: AgentStatus;
  createdAt: ISOTimestamp;
  lastSeenAt: ISOTimestamp | null;
}

export interface CreateAgentInput {
  walletPubkey: SolanaPubkey;
  name: string;
  framework: AgentFramework;
  agentType: AgentType;
  tags?: readonly string[] | undefined;
  webhookUrl?: string | null | undefined;
  telegramChatId?: string | null | undefined;
  alertRules?: AlertRuleThresholds | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  tags?: readonly string[] | undefined;
  webhookUrl?: string | null | undefined;
  telegramChatId?: string | null | undefined;
  alertRules?: AlertRuleThresholds | undefined;
}

// ─── Transaction ──────────────────────────────────────────────────────────────

/** Net change of a single SPL token within one transaction. */
export interface TokenDelta {
  mint: SolanaPubkey;
  decimals: number;
  /** Signed integer string in raw token units (no decimals applied). */
  delta: string;
}

/**
 * Normalized parsed instruction args. Schema is parser-specific
 * (e.g. Jupiter swap: { inputMint, outputMint, inAmount, outAmount, slippageBps }).
 */
export type ParsedArgs = Record<string, unknown>;

export interface AgentTransaction {
  id: number;
  agentId: UUID;
  signature: SolanaSignature;
  slot: number;
  blockTime: ISOTimestamp;
  programId: SolanaPubkey;
  /** Dot-namespaced instruction identifier, e.g. "jupiter.swap" or "kamino.deposit". */
  instructionName: string | null;
  parsedArgs: ParsedArgs | null;
  /** Net SOL delta (positive = gained), as decimal string with 9-digit precision. */
  solDelta: string;
  tokenDeltas: readonly TokenDelta[];
  feeLamports: number;
  success: boolean;
  rawLogs: readonly string[];
}

// ─── Reasoning log (OpenTelemetry span) ───────────────────────────────────────

/**
 * Free-form OTel span attributes (string-keyed, JSON-serializable values).
 *
 * Mirrors what OTLP's AnyValue flattens to after persistence: scalars,
 * arrays, and nested kvlist objects. The narrower scalars-only shape was
 * wrong because the OTLP receiver stores arrayValue / kvlistValue variants
 * verbatim — reading a persisted row back through this type would fail
 * assignability without the union.
 */
export type SpanAttributes = Record<
  string,
  string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>
>;

export interface ReasoningLog {
  id: UUID;
  agentId: UUID;
  /** OTel trace_id, 32-char lowercase hex (16 bytes). */
  traceId: string;
  /** OTel span_id, 16-char lowercase hex (8 bytes). */
  spanId: string;
  /** Parent span_id within same trace, or null for root span. */
  parentSpanId: string | null;
  spanName: string;
  startTime: ISOTimestamp;
  endTime: ISOTimestamp;
  attributes: SpanAttributes;
  /** Optional correlation with on-chain transaction. */
  txSignature: SolanaSignature | null;
}

// ─── Alert ────────────────────────────────────────────────────────────────────

/**
 * Rule-specific context payload (e.g. for slippage_spike:
 * { thresholdPct: 5, actualPct: 47.3, signature: "..." }).
 */
export type AlertPayload = Record<string, unknown>;

export interface Alert {
  id: UUID;
  agentId: UUID;
  ruleName: AlertRuleName;
  severity: AlertSeverity;
  payload: AlertPayload;
  triggeredAt: ISOTimestamp;
  deliveredAt: ISOTimestamp | null;
  deliveryChannel: DeliveryChannel | null;
  deliveryStatus: DeliveryStatus;
  deliveryError: string | null;
}

// ─── API response envelopes ───────────────────────────────────────────────────

export interface ApiError {
  code: 'INVALID_INPUT' | 'UNAUTHORIZED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'INTERNAL';
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface ApiErrorResponse {
  error: ApiError;
}

export interface CursorPage<T> {
  items: readonly T[];
  nextCursor: string | null;
}

// ─── SSE event payloads ───────────────────────────────────────────────────────

export type SseEvent =
  | { type: 'tx'; data: AgentTransaction }
  | { type: 'reasoning'; data: ReasoningLog }
  | { type: 'alert'; data: Alert }
  | { type: 'ping'; data: { ts: ISOTimestamp } };
