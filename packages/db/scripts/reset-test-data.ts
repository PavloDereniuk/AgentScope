/**
 * Wipe test data from agent_transactions and the seeded test agent.
 * Safe to run any time during development.
 *
 * Usage: DATABASE_URL=... pnpm tsx scripts/reset-test-data.ts
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { users } from '../src/schema';
import { requireLocalDb } from './_guard';

// Destructive: TRUNCATE wipes agent_transactions/reasoning_logs/alerts.
// Guard prevents accidental data loss on hosted DBs (Supabase/Railway/Neon)
// — set AGENTSCOPE_ALLOW_PROD_DUMP=1 to override.
const url = requireLocalDb('reset-test-data');

const db = createDb({ connectionString: url });

async function main() {
  // 1. Truncate transactions, reasoning logs, alerts (cascade reaches partitions).
  console.log('truncating agent_transactions, reasoning_logs, alerts...');
  await db.execute(
    sql`TRUNCATE TABLE agent_transactions, reasoning_logs, alerts RESTART IDENTITY CASCADE`,
  );

  // 2. Delete the seeded test agent (and its row in agents).
  console.log('deleting seed test user + agent...');
  const deleted = await db
    .delete(users)
    .where(sql`${users.privyDid} = 'did:privy:test_seed_user'`)
    .returning({ id: users.id });
  console.log('deleted users:', deleted.length);

  // 3. Print final counts.
  const agentCount = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agents`);
  const txCount = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM agent_transactions`,
  );
  console.log('\nagents:', agentCount[0]?.n, ' transactions:', txCount[0]?.n);
  console.log('\n✅ test data reset');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ reset failed:', err);
    process.exit(1);
  });
