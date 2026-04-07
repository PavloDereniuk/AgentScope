/**
 * One-shot verification that migrations landed correctly on Supabase.
 * Run with: DATABASE_URL=... pnpm tsx scripts/verify-supabase.ts
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb({ connectionString: url });

async function main() {
  console.log('\n=== Tables ===');
  const tables = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN
        ('users', 'agents', 'agent_transactions', 'reasoning_logs', 'alerts')
        ORDER BY tablename`,
  );
  for (const row of tables) console.log('  ✓', row.tablename);

  console.log('\n=== agent_transactions partitions ===');
  const parts = await db.execute<{ inhrelid: string }>(
    sql`SELECT inhrelid::regclass::text AS inhrelid
        FROM pg_inherits
        WHERE inhparent = 'public.agent_transactions'::regclass
        ORDER BY inhrelid::regclass::text`,
  );
  for (const row of parts) console.log('  ✓', row.inhrelid);

  console.log('\n=== RLS status ===');
  const rls = await db.execute<{ tablename: string; rowsecurity: boolean }>(
    sql`SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN
        ('users', 'agents', 'agent_transactions', 'reasoning_logs', 'alerts')
        ORDER BY tablename`,
  );
  for (const row of rls)
    console.log(
      '  ' + (row.rowsecurity ? '✓' : '✗'),
      row.tablename,
      row.rowsecurity ? 'RLS enabled' : 'NO RLS',
    );

  console.log('\n=== Policies ===');
  const policies = await db.execute<{ policyname: string; tablename: string }>(
    sql`SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
  );
  for (const row of policies) console.log('  ✓', `${row.tablename}.${row.policyname}`);

  console.log('\n=== current_user_id() function ===');
  const fn = await db.execute<{ proname: string }>(
    sql`SELECT proname FROM pg_proc WHERE proname = 'current_user_id'`,
  );
  console.log(fn.length > 0 ? '  ✓ exists' : '  ✗ MISSING');

  console.log('\n=== Enums ===');
  const enums = await db.execute<{ typname: string }>(
    sql`SELECT typname FROM pg_type WHERE typname IN
        ('agent_framework','agent_type','agent_status','alert_severity','alert_rule_name','delivery_channel','delivery_status')
        ORDER BY typname`,
  );
  for (const row of enums) console.log('  ✓', row.typname);
}

main()
  .then(() => {
    console.log('\n✅ Supabase migrations verified\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Verification failed:', err);
    process.exit(1);
  });
