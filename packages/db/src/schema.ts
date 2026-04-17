/**
 * Drizzle ORM schema for AgentScope.
 *
 * Tables: users, agents, agent_transactions, reasoning_logs, alerts.
 *
 * NOTE on partitioning: drizzle-kit cannot generate native PostgreSQL
 * partitioning syntax. The `agent_transactions` table is defined here
 * as a regular table; partition-by-range conversion happens in a raw
 * SQL migration in task 1.5 alongside RLS policies.
 *
 * NOTE on enums: enum string tuples are imported from @agentscope/shared
 * so types.ts and the database stay in lock-step.
 */

import {
  AGENT_FRAMEWORKS,
  AGENT_STATUSES,
  AGENT_TYPES,
  ALERT_RULE_NAMES,
  ALERT_SEVERITIES,
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
} from '@agentscope/shared';
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ─── Enums ─────────────────────────────────────────────────────────────────

// Drizzle pgEnum requires a non-empty tuple literal. The shared `as const`
// arrays satisfy that — we just spread them through a typed cast helper.
const tuple = <T extends readonly [string, ...string[]]>(arr: T): T => arr;

export const agentFrameworkEnum = pgEnum(
  'agent_framework',
  tuple(AGENT_FRAMEWORKS as unknown as readonly [string, ...string[]]),
);
export const agentTypeEnum = pgEnum(
  'agent_type',
  tuple(AGENT_TYPES as unknown as readonly [string, ...string[]]),
);
export const agentStatusEnum = pgEnum(
  'agent_status',
  tuple(AGENT_STATUSES as unknown as readonly [string, ...string[]]),
);
export const alertSeverityEnum = pgEnum(
  'alert_severity',
  tuple(ALERT_SEVERITIES as unknown as readonly [string, ...string[]]),
);
export const alertRuleNameEnum = pgEnum(
  'alert_rule_name',
  tuple(ALERT_RULE_NAMES as unknown as readonly [string, ...string[]]),
);
export const deliveryChannelEnum = pgEnum(
  'delivery_channel',
  tuple(DELIVERY_CHANNELS as unknown as readonly [string, ...string[]]),
);
export const deliveryStatusEnum = pgEnum(
  'delivery_status',
  tuple(DELIVERY_STATUSES as unknown as readonly [string, ...string[]]),
);

// ─── users ─────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    privyDid: text('privy_did').notNull(),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    privyDidUnique: uniqueIndex('users_privy_did_unique').on(t.privyDid),
  }),
);

// ─── agents ────────────────────────────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    walletPubkey: text('wallet_pubkey').notNull(),
    name: text('name').notNull(),
    framework: agentFrameworkEnum('framework').notNull(),
    agentType: agentTypeEnum('agent_type').notNull(),
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
    webhookUrl: text('webhook_url'),
    alertRules: jsonb('alert_rules').notNull().default({}),
    /** Opaque token used by the agent's OTel exporter for /v1/traces. */
    ingestToken: text('ingest_token').notNull(),
    status: agentStatusEnum('status').notNull().default('stale'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => ({
    userWalletUnique: uniqueIndex('agents_user_wallet_unique').on(t.userId, t.walletPubkey),
    userIdx: index('agents_user_idx').on(t.userId),
    walletIdx: index('agents_wallet_idx').on(t.walletPubkey),
    ingestTokenUnique: uniqueIndex('agents_ingest_token_unique').on(t.ingestToken),
  }),
);

// ─── agent_transactions ────────────────────────────────────────────────────
// Composite PK (id, block_time) — required by Postgres native partitioning,
// since the partition key MUST be part of every unique constraint. The
// PARTITION BY RANGE (block_time) clause and child partitions are added in
// raw SQL migration 0001_rls_and_partition.sql (drizzle-kit cannot emit it).
//
// Drizzle's table state matches the post-migration shape, so subsequent
// `db:generate` runs are idempotent — drizzle does not inspect the partition
// modifier itself, only columns/constraints/indexes.

export const agentTransactions = pgTable(
  'agent_transactions',
  {
    id: bigserial('id', { mode: 'number' }).notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull(),
    slot: bigint('slot', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true, mode: 'string' }).notNull(),
    programId: text('program_id').notNull(),
    instructionName: text('instruction_name'),
    parsedArgs: jsonb('parsed_args'),
    /** Net SOL delta, signed, decimal(20,9) — preserves lamport precision. */
    solDelta: numeric('sol_delta', { precision: 20, scale: 9 }).notNull().default('0'),
    tokenDeltas: jsonb('token_deltas').notNull().default([]),
    feeLamports: bigint('fee_lamports', { mode: 'number' }).notNull().default(0),
    success: boolean('success').notNull(),
    rawLogs: text('raw_logs').array().notNull().default(sql`ARRAY[]::text[]`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.blockTime] }),
    agentTimeIdx: index('tx_agent_time_idx').on(t.agentId, t.blockTime),
    signatureIdx: index('tx_signature_idx').on(t.signature),
    instructionIdx: index('tx_instruction_idx').on(t.instructionName),
  }),
);

// ─── reasoning_logs ────────────────────────────────────────────────────────

export const reasoningLogs = pgTable(
  'reasoning_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** OTel trace_id, 32-char lowercase hex. */
    traceId: text('trace_id').notNull(),
    /** OTel span_id, 16-char lowercase hex. */
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    spanName: text('span_name').notNull(),
    startTime: timestamp('start_time', { withTimezone: true, mode: 'string' }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true, mode: 'string' }).notNull(),
    attributes: jsonb('attributes').notNull().default({}),
    /** Optional correlation with on-chain transaction. */
    txSignature: text('tx_signature'),
  },
  (t) => ({
    agentTimeIdx: index('reason_agent_time_idx').on(t.agentId, t.startTime),
    traceIdx: index('reason_trace_idx').on(t.traceId),
    txSignatureIdx: index('reason_tx_signature_idx').on(t.txSignature),
    spanUnique: uniqueIndex('reason_span_unique').on(t.traceId, t.spanId),
  }),
);

// ─── alerts ────────────────────────────────────────────────────────────────

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ruleName: alertRuleNameEnum('rule_name').notNull(),
    severity: alertSeverityEnum('severity').notNull(),
    payload: jsonb('payload').notNull().default({}),
    triggeredAt: timestamp('triggered_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
    deliveryChannel: deliveryChannelEnum('delivery_channel'),
    deliveryStatus: deliveryStatusEnum('delivery_status').notNull().default('pending'),
    deliveryError: text('delivery_error'),
    /**
     * Per-rule cooldown key — used by detector to avoid duplicate alerts
     * within a window. Indexed for fast lookup of latest alert by (agent, rule).
     *
     * Nullable by design: not every future rule must participate in dedupe.
     * When null, the uniqueness constraint is bypassed (Postgres treats null
     * as distinct), so the alert is always inserted. Rules that *do* want
     * dedupe must always produce a non-null key — the detector-runner uses
     * this key to correlate RETURNING rows back to RuleResults, and a null
     * key silently falls back to per-agent/per-rule pairing.
     */
    dedupeKey: text('dedupe_key'),
  },
  (t) => ({
    agentTimeIdx: index('alerts_agent_time_idx').on(t.agentId, t.triggeredAt),
    ruleIdx: index('alerts_rule_idx').on(t.ruleName, t.triggeredAt),
    dedupeIdx: index('alerts_dedupe_idx').on(t.agentId, t.ruleName, t.dedupeKey),
  }),
);

// ─── Relations (for type-safe joins) ───────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  agents: many(agents),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  user: one(users, { fields: [agents.userId], references: [users.id] }),
  transactions: many(agentTransactions),
  reasoningLogs: many(reasoningLogs),
  alerts: many(alerts),
}));

export const agentTransactionsRelations = relations(agentTransactions, ({ one }) => ({
  agent: one(agents, { fields: [agentTransactions.agentId], references: [agents.id] }),
}));

export const reasoningLogsRelations = relations(reasoningLogs, ({ one }) => ({
  agent: one(agents, { fields: [reasoningLogs.agentId], references: [agents.id] }),
}));

export const alertsRelations = relations(alerts, ({ one }) => ({
  agent: one(agents, { fields: [alerts.agentId], references: [agents.id] }),
}));

// ─── Inferred row types ────────────────────────────────────────────────────

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type AgentTransactionRow = typeof agentTransactions.$inferSelect;
export type NewAgentTransactionRow = typeof agentTransactions.$inferInsert;
export type ReasoningLogRow = typeof reasoningLogs.$inferSelect;
export type NewReasoningLogRow = typeof reasoningLogs.$inferInsert;
export type AlertRow = typeof alerts.$inferSelect;
export type NewAlertRow = typeof alerts.$inferInsert;
