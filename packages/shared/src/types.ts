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

export const DELIVERY_CHANNELS = ['telegram', 'discord', 'slack'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ─── Branded primitives ───────────────────────────────────────────────────────

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

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
 */
export interface AlertRuleThresholds {
  slippagePctThreshold?: number;
  gasMultThreshold?: number;
  drawdownPctThreshold?: number;
  errorRatePctThreshold?: number;
  staleMinutesThreshold?: number;
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
  alertRules: AlertRuleThresholds;
  /** Opaque token used by the agent's OTel exporter to authenticate /v1/traces. */
  ingestToken: string;
  status: AgentStatus;
  createdAt: ISOTimestamp;
  lastSeenAt: ISOTimestamp | null;
}

export type CreateAgentInput = Pick<Agent, 'walletPubkey' | 'name' | 'framework' | 'agentType'> & {
  tags?: readonly string[];
  webhookUrl?: string | null;
  alertRules?: AlertRuleThresholds;
};

export type UpdateAgentInput = Partial<Pick<Agent, 'name' | 'tags' | 'webhookUrl' | 'alertRules'>>;

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

/** Free-form OTel span attributes (string-keyed, JSON-serializable values). */
export type SpanAttributes = Record<string, string | number | boolean | null>;

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
  details?: Record<string, unknown>;
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
