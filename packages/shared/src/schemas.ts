/**
 * AgentScope Zod schemas. Single validation source for API boundaries
 * (Hono routes, OTLP receiver, ingestion persist).
 *
 * Each exported schema is named `<entity>Schema`. The inferred type from
 * `z.infer<typeof xSchema>` MUST be assignable to the matching export
 * in `./types.ts`. Type alignment is enforced by `_typeCheck` constants
 * at the bottom of this file.
 */

import { z } from 'zod';
import { SOLANA_SIGNATURE_RE } from './signature';
import type {
  Agent,
  AgentTransaction,
  Alert,
  AlertRuleThresholds,
  CreateAgentInput,
  ISOTimestamp,
  PrivyDID,
  ReasoningLog,
  SolanaPubkey,
  SolanaSignature,
  TokenDelta,
  UUID,
  UpdateAgentInput,
  User,
} from './types';
import {
  AGENT_FRAMEWORKS,
  AGENT_STATUSES,
  AGENT_TYPES,
  ALERT_RULE_NAMES,
  ALERT_SEVERITIES,
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
} from './types';

// ─── Branded primitives ────────────────────────────────────────────────────

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const solanaPubkeySchema = z
  .string()
  .min(32)
  .max(44)
  .regex(BASE58_RE, 'must be base58')
  .transform((s) => s as unknown as SolanaPubkey);

// Length bounds {32,88} are encoded in the canonical regex; see
// ./signature.ts for the rationale (leading-zero base58 compression).
// All producers (OTLP receiver, eliza hooks, alerter, dashboard, and this
// schema) must agree on the same accept-set.
export const solanaSignatureSchema = z
  .string()
  .regex(SOLANA_SIGNATURE_RE, 'must be a valid solana signature')
  .transform((s) => s as unknown as SolanaSignature);

export const uuidSchema = z
  .string()
  .uuid()
  .transform((s) => s as unknown as UUID);

export const privyDidSchema = z
  .string()
  .min(1)
  .startsWith('did:privy:')
  .transform((s) => s as unknown as PrivyDID);

export const isoTimestampSchema = z
  .string()
  // offset: true accepts both Z and +HH:MM suffixes; transform normalizes to UTC Z format.
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString() as unknown as ISOTimestamp);

// ─── Enum schemas ──────────────────────────────────────────────────────────

export const agentFrameworkSchema = z.enum(AGENT_FRAMEWORKS);
export const agentTypeSchema = z.enum(AGENT_TYPES);
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export const alertSeveritySchema = z.enum(ALERT_SEVERITIES);
export const alertRuleNameSchema = z.enum(ALERT_RULE_NAMES);
export const deliveryChannelSchema = z.enum(DELIVERY_CHANNELS);
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);

// ─── User ──────────────────────────────────────────────────────────────────

export const userSchema = z.object({
  id: uuidSchema,
  privyDid: privyDidSchema,
  email: z.string().email().nullable(),
  createdAt: isoTimestampSchema,
});

// ─── Agent ─────────────────────────────────────────────────────────────────

export const alertRuleThresholdsSchema = z.object({
  slippagePctThreshold: z.number().positive().optional(),
  gasMultThreshold: z.number().positive().optional(),
  drawdownPctThreshold: z.number().positive().optional(),
  errorRatePctThreshold: z.number().min(0).max(100).optional(),
  staleMinutesThreshold: z.number().int().positive().optional(),
});

/**
 * Telegram chat_id: numeric string (user `123456789`, group/channel `-100123456789`).
 * Accept optional leading `-` and 1–32 digits; reject whitespace and non-digits.
 * Kept permissive (no 15-digit cap) so future 64-bit-typed chat_ids still pass,
 * but tight enough that pasted usernames or URLs are rejected at the API edge.
 */
export const telegramChatIdSchema = z
  .string()
  .trim()
  .regex(/^-?\d{1,32}$/, 'must be numeric telegram chat_id');

export const agentSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  walletPubkey: solanaPubkeySchema,
  name: z.string().min(1).max(120),
  framework: agentFrameworkSchema,
  agentType: agentTypeSchema,
  tags: z.array(z.string().min(1).max(40)).max(20).readonly(),
  webhookUrl: z.string().url().nullable(),
  telegramChatId: telegramChatIdSchema.nullable(),
  alertRules: alertRuleThresholdsSchema,
  ingestToken: z.string().min(1),
  status: agentStatusSchema,
  createdAt: isoTimestampSchema,
  lastSeenAt: isoTimestampSchema.nullable(),
});

export const createAgentInputSchema = z.object({
  walletPubkey: solanaPubkeySchema,
  name: z.string().min(1).max(120),
  framework: agentFrameworkSchema,
  agentType: agentTypeSchema,
  tags: z.array(z.string().min(1).max(40)).max(20).readonly().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  telegramChatId: telegramChatIdSchema.nullable().optional(),
  alertRules: alertRuleThresholdsSchema.optional(),
});

export const updateAgentInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    tags: z.array(z.string().min(1).max(40)).max(20).readonly(),
    webhookUrl: z.string().url().nullable(),
    telegramChatId: telegramChatIdSchema.nullable(),
    alertRules: alertRuleThresholdsSchema,
  })
  .partial();

// ─── Transaction ───────────────────────────────────────────────────────────

const decimalStringRe = /^-?\d+(\.\d+)?$/;
export const decimalStringSchema = z.string().regex(decimalStringRe, 'must be decimal');

export const tokenDeltaSchema = z.object({
  mint: solanaPubkeySchema,
  decimals: z.number().int().min(0).max(18),
  delta: z.string().regex(/^-?\d+$/, 'must be integer string'),
});

export const parsedArgsSchema = z.record(z.string(), z.unknown());

export const agentTransactionSchema = z.object({
  id: z.number().int().nonnegative(),
  agentId: uuidSchema,
  signature: solanaSignatureSchema,
  slot: z.number().int().nonnegative(),
  blockTime: isoTimestampSchema,
  programId: solanaPubkeySchema,
  instructionName: z.string().min(1).max(120).nullable(),
  parsedArgs: parsedArgsSchema.nullable(),
  solDelta: decimalStringSchema,
  tokenDeltas: z.array(tokenDeltaSchema).readonly(),
  feeLamports: z.number().int().nonnegative(),
  success: z.boolean(),
  rawLogs: z.array(z.string()).readonly(),
});

// ─── Reasoning ─────────────────────────────────────────────────────────────

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

// OTLP AnyValue flattens into scalars, arrays (homogeneous per spec but we
// tolerate mixed) and nested kvlist objects. The receiver's flattenAnyValue
// preserves that shape in `reasoning_logs.attributes`, so this schema must
// accept it when the same row is read back through the shared types.
export const spanAttributesSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
  ]),
);

export const reasoningLogSchema = z.object({
  id: uuidSchema,
  agentId: uuidSchema,
  traceId: z.string().regex(TRACE_ID_RE, 'must be 32-char lowercase hex'),
  spanId: z.string().regex(SPAN_ID_RE, 'must be 16-char lowercase hex'),
  parentSpanId: z.string().regex(SPAN_ID_RE).nullable(),
  spanName: z.string().min(1).max(200),
  startTime: isoTimestampSchema,
  endTime: isoTimestampSchema,
  attributes: spanAttributesSchema,
  txSignature: solanaSignatureSchema.nullable(),
});

// ─── Alert ─────────────────────────────────────────────────────────────────

export const alertPayloadSchema = z.record(z.string(), z.unknown());

export const alertSchema = z.object({
  id: uuidSchema,
  agentId: uuidSchema,
  ruleName: alertRuleNameSchema,
  severity: alertSeveritySchema,
  payload: alertPayloadSchema,
  triggeredAt: isoTimestampSchema,
  deliveredAt: isoTimestampSchema.nullable(),
  deliveryChannel: deliveryChannelSchema.nullable(),
  deliveryStatus: deliveryStatusSchema,
  deliveryError: z.string().nullable(),
});

// ─── API envelopes ─────────────────────────────────────────────────────────

export const apiErrorSchema = z.object({
  code: z.enum(['INVALID_INPUT', 'UNAUTHORIZED', 'NOT_FOUND', 'RATE_LIMITED', 'INTERNAL']),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const apiErrorResponseSchema = z.object({
  error: apiErrorSchema,
});

/**
 * Generic cursor page schema factory.
 * Usage: `cursorPageSchema(agentSchema)` → schema for `CursorPage<Agent>`.
 */
export function cursorPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item).readonly(),
    nextCursor: z.string().nullable(),
  });
}

// ─── SSE event union ───────────────────────────────────────────────────────

export const sseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tx'), data: agentTransactionSchema }),
  z.object({ type: z.literal('reasoning'), data: reasoningLogSchema }),
  z.object({ type: z.literal('alert'), data: alertSchema }),
  z.object({
    type: z.literal('ping'),
    data: z.object({ ts: isoTimestampSchema }),
  }),
]);

// ─── Type alignment guards (compile-time only) ─────────────────────────────
// These constants exist purely so `tsc` rejects this file if any z.infer<>
// drifts from the matching type in types.ts. They are erased at runtime.

const _userCheck: User = {} as z.infer<typeof userSchema>;
const _agentCheck: Agent = {} as z.infer<typeof agentSchema>;
const _createAgentCheck: CreateAgentInput = {} as z.infer<typeof createAgentInputSchema>;
const _updateAgentCheck: UpdateAgentInput = {} as z.infer<typeof updateAgentInputSchema>;
const _txCheck: AgentTransaction = {} as z.infer<typeof agentTransactionSchema>;
const _tokenDeltaCheck: TokenDelta = {} as z.infer<typeof tokenDeltaSchema>;
const _alertRulesCheck: AlertRuleThresholds = {} as z.infer<typeof alertRuleThresholdsSchema>;
const _reasoningCheck: ReasoningLog = {} as z.infer<typeof reasoningLogSchema>;
const _alertCheck: Alert = {} as z.infer<typeof alertSchema>;
void _userCheck;
void _agentCheck;
void _createAgentCheck;
void _updateAgentCheck;
void _txCheck;
void _tokenDeltaCheck;
void _alertRulesCheck;
void _reasoningCheck;
void _alertCheck;
