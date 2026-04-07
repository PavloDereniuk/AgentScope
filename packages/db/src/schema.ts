/**
 * Drizzle ORM schema for AgentScope.
 *
 * Tables: users, agents, agent_transactions (partitioned by month),
 * reasoning_logs, alerts. RLS policies live in raw SQL migration files
 * under ./migrations and are applied alongside drizzle-kit migrations.
 *
 * NOTE: Schema definitions land in task 1.4. This file is a stub so the
 * package compiles and `client.ts` has a target to import once 1.4 lands.
 */

export {};
