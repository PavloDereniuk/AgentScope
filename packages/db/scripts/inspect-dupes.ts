import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

// Full-table scans on `agent_transactions` (partitioned by block_time) are
// expensive on Supabase free tier — one full-table count across 12 partitions
// can blow through the 30s statement_timeout. Default to a 7-day window and
// let operators opt into a full scan explicitly.
const WINDOW_DAYS_ENV = process.env['INSPECT_WINDOW_DAYS'];
const WINDOW_DAYS = WINDOW_DAYS_ENV === 'all' ? null : Number(WINDOW_DAYS_ENV ?? 7);
if (WINDOW_DAYS !== null && !Number.isInteger(WINDOW_DAYS)) {
  throw new Error('INSPECT_WINDOW_DAYS must be an integer or "all"');
}
const windowFilter = WINDOW_DAYS === null ? sql`TRUE` : sql`block_time > now() - interval '${sql.raw(`${WINDOW_DAYS} days`)}'`;
console.log(`Scanning agent_transactions — window: ${WINDOW_DAYS === null ? 'ALL' : `last ${WINDOW_DAYS} days`}`);

const db = createDb({ connectionString: url });

const total = await db.execute<{ n: number }>(
  sql`SELECT count(*)::int AS n FROM agent_transactions WHERE ${windowFilter}`,
);
console.log('agent_transactions rows in window:', total[0]?.n);

const distinct = await db.execute<{ n: number }>(
  sql`SELECT count(DISTINCT signature)::int AS n FROM agent_transactions WHERE ${windowFilter}`,
);
console.log('distinct signatures in window:', distinct[0]?.n);

const dupes = await db.execute<{
  signature: string;
  n: number;
  agent_ids: string;
  block_times: string;
}>(sql`
  SELECT signature,
         count(*)::int AS n,
         string_agg(DISTINCT agent_id::text, ',') AS agent_ids,
         string_agg(DISTINCT block_time::text, ' | ') AS block_times
  FROM agent_transactions
  WHERE ${windowFilter}
  GROUP BY signature
  HAVING count(*) > 1
  ORDER BY count(*) DESC, max(block_time) DESC
  LIMIT 10
`);

console.log('\ntop dupes (signature | count | agent_ids | block_times):');
for (const row of dupes) {
  console.log(`  ${row.signature.slice(0, 20)}... | n=${row.n} | agents=${row.agent_ids} | times=${row.block_times}`);
}

// Check constraints on agent_transactions
const constraints = await db.execute<{
  conname: string;
  contype: string;
  def: string;
}>(sql`
  SELECT conname, contype::text, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = 'agent_transactions'::regclass
  ORDER BY contype, conname
`);

console.log('\nagent_transactions constraints:');
for (const row of constraints) {
  console.log(`  ${row.contype} ${row.conname}: ${row.def}`);
}

const indexes = await db.execute<{ indexname: string; indexdef: string }>(
  sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_transactions' ORDER BY indexname`,
);
console.log('\nagent_transactions indexes:');
for (const row of indexes) console.log(`  ${row.indexname}: ${row.indexdef}`);

process.exit(0);
