/**
 * Smoke test for the @agentscope/db schema using PGlite — a real
 * PostgreSQL 16 build compiled to WebAssembly. This gives us the same
 * runtime semantics as production Supabase (jsonb, uuid, ENUMs, FKs,
 * partitions, RLS) without spinning up a Docker container.
 *
 * Goal: validate that schema.ts is consistent with the migration SQL
 * and that drizzle's CRUD operators round-trip correctly.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentTransactions, agents, alerts, reasoningLogs, users } from '../src/schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'migrations');

let client: PGlite;
let db: ReturnType<typeof drizzle>;

/**
 * Apply migration SQL files in journal order. We don't use drizzle's
 * `migrate()` here because PGlite doesn't expose drizzle's expected
 * migration tracking shape, and we want explicit control to skip the
 * 0001 RLS+partition migration in case PGlite chokes on any pg-specific
 * syntax (it's strict about session vars / ALTER ROLE etc.).
 */
async function applyMigration(file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
  // drizzle uses a literal "--> statement-breakpoint" marker to split files
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await client.exec(stmt);
  }
}

beforeAll(async () => {
  client = new PGlite();
  await client.waitReady;
  db = drizzle(client);
  await applyMigration('0000_far_morbius.sql');
  await applyMigration('0001_rls_and_partition.sql');
});

afterAll(async () => {
  await client.close();
});

describe('schema migrations', () => {
  it('creates all 5 core tables', async () => {
    const result = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN
       ('users', 'agents', 'agent_transactions', 'reasoning_logs', 'alerts')
       ORDER BY tablename`,
    );
    const names = result.rows.map((r) => r.tablename).sort();
    expect(names).toEqual(['agent_transactions', 'agents', 'alerts', 'reasoning_logs', 'users']);
  });

  it('creates monthly partitions for agent_transactions', async () => {
    const result = await client.query<{ inhrelid: string }>(
      `SELECT inhrelid::regclass::text AS inhrelid
       FROM pg_inherits
       WHERE inhparent = 'public.agent_transactions'::regclass
       ORDER BY inhrelid::regclass::text`,
    );
    const partitions = result.rows.map((r) => r.inhrelid);
    expect(partitions).toContain('agent_transactions_2026_04');
    expect(partitions).toContain('agent_transactions_2026_05');
    expect(partitions.length).toBeGreaterThanOrEqual(6);
  });

  it('enables RLS on all tables', async () => {
    const result = await client.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
       WHERE schemaname = 'public' AND tablename IN
       ('users', 'agents', 'agent_transactions', 'reasoning_logs', 'alerts')`,
    );
    for (const row of result.rows) {
      expect(row.rowsecurity, `${row.tablename} should have RLS enabled`).toBe(true);
    }
  });
});

describe('drizzle CRUD round-trips', () => {
  it('inserts a user and reads it back', async () => {
    const inserted = await db
      .insert(users)
      .values({
        privyDid: 'did:privy:test_user_1',
        email: 'test@example.com',
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.privyDid).toBe('did:privy:test_user_1');
    expect(inserted[0]?.email).toBe('test@example.com');
    expect(inserted[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('inserts an agent linked to a user and reads it back', async () => {
    const [user] = await db.insert(users).values({ privyDid: 'did:privy:test_user_2' }).returning();
    expect(user).toBeDefined();
    if (!user) throw new Error('user insert failed');

    const inserted = await db
      .insert(agents)
      .values({
        userId: user.id,
        walletPubkey: '11111111111111111111111111111111',
        name: 'Smoke Test Agent',
        framework: 'elizaos',
        agentType: 'trader',
        ingestToken: 'tok_smoke_1',
        tags: ['smoke', 'demo'],
        alertRules: { slippagePctThreshold: 7.5 },
      })
      .returning();

    expect(inserted).toHaveLength(1);
    const agent = inserted[0];
    if (!agent) throw new Error('agent insert failed');
    expect(agent.name).toBe('Smoke Test Agent');
    expect(agent.framework).toBe('elizaos');
    expect(agent.agentType).toBe('trader');
    expect(agent.tags).toEqual(['smoke', 'demo']);
    expect(agent.status).toBe('stale'); // default
    expect(agent.alertRules).toEqual({ slippagePctThreshold: 7.5 });

    const found = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(agent.id);
  });

  it('cascades agent deletion to transactions, reasoning logs, and alerts', async () => {
    const [user] = await db
      .insert(users)
      .values({ privyDid: 'did:privy:cascade_user' })
      .returning();
    if (!user) throw new Error('user insert failed');

    const [agent] = await db
      .insert(agents)
      .values({
        userId: user.id,
        walletPubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        name: 'Cascade Agent',
        framework: 'agent-kit',
        agentType: 'yield',
        ingestToken: 'tok_cascade_1',
      })
      .returning();
    if (!agent) throw new Error('agent insert failed');

    await db.insert(agentTransactions).values({
      agentId: agent.id,
      signature: 'sig_cascade_1',
      slot: 100,
      blockTime: '2026-04-15T12:00:00.000Z',
      programId: '11111111111111111111111111111111',
      success: true,
    });

    await db.insert(reasoningLogs).values({
      agentId: agent.id,
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      spanName: 'decision',
      startTime: '2026-04-15T12:00:00.000Z',
      endTime: '2026-04-15T12:00:01.000Z',
    });

    await db.insert(alerts).values({
      agentId: agent.id,
      ruleName: 'slippage_spike',
      severity: 'critical',
      payload: { thresholdPct: 5, actualPct: 47 },
    });

    await db.delete(agents).where(eq(agents.id, agent.id));

    const txAfter = await db
      .select()
      .from(agentTransactions)
      .where(eq(agentTransactions.agentId, agent.id));
    const reasonAfter = await db
      .select()
      .from(reasoningLogs)
      .where(eq(reasoningLogs.agentId, agent.id));
    const alertAfter = await db.select().from(alerts).where(eq(alerts.agentId, agent.id));

    expect(txAfter).toHaveLength(0);
    expect(reasonAfter).toHaveLength(0);
    expect(alertAfter).toHaveLength(0);
  });

  it('enforces unique (user_id, wallet_pubkey) on agents', async () => {
    const [user] = await db.insert(users).values({ privyDid: 'did:privy:unique_user' }).returning();
    if (!user) throw new Error('user insert failed');

    await db.insert(agents).values({
      userId: user.id,
      walletPubkey: 'So11111111111111111111111111111111111111112',
      name: 'First',
      framework: 'custom',
      agentType: 'other',
      ingestToken: 'tok_uniq_1',
    });

    await expect(
      db.insert(agents).values({
        userId: user.id,
        walletPubkey: 'So11111111111111111111111111111111111111112',
        name: 'Duplicate',
        framework: 'custom',
        agentType: 'other',
        ingestToken: 'tok_uniq_2',
      }),
    ).rejects.toThrow();
  });
});
