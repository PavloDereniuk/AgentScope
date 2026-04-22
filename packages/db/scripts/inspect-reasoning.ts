import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

// reasoning_logs is a single (non-partitioned) table but grows per-span;
// scope by default to avoid full-table scans on large prod data.
const WINDOW_DAYS_ENV = process.env['INSPECT_WINDOW_DAYS'];
const WINDOW_DAYS = WINDOW_DAYS_ENV === 'all' ? null : Number(WINDOW_DAYS_ENV ?? 7);
if (WINDOW_DAYS !== null && !Number.isInteger(WINDOW_DAYS)) {
  throw new Error('INSPECT_WINDOW_DAYS must be an integer or "all"');
}
const windowFilter =
  WINDOW_DAYS === null ? sql`TRUE` : sql`start_time > now() - interval '${sql.raw(`${WINDOW_DAYS} days`)}'`;
console.log(`Scanning reasoning_logs — window: ${WINDOW_DAYS === null ? 'ALL' : `last ${WINDOW_DAYS} days`}`);

const db = createDb({ connectionString: url });

const totals = await db.execute<{ n: number }>(
  sql`SELECT count(*)::int AS n FROM reasoning_logs WHERE ${windowFilter}`,
);
console.log('reasoning_logs rows in window:', totals[0]?.n);

const withSig = await db.execute<{ n: number }>(
  sql`SELECT count(DISTINCT tx_signature)::int AS n FROM reasoning_logs WHERE tx_signature IS NOT NULL AND ${windowFilter}`,
);
console.log('distinct tx_signatures with spans:', withSig[0]?.n);

const correlated = await db.execute<{
  signature: string;
  persisted_in_tx: string;
  span_count: number;
  trace_span_count: number;
  instruction_name: string | null;
}>(sql`
  WITH sig_traces AS (
    SELECT tx_signature, trace_id
    FROM reasoning_logs
    WHERE tx_signature IS NOT NULL
    GROUP BY tx_signature, trace_id
  )
  SELECT
    st.tx_signature AS signature,
    CASE WHEN tx.signature IS NOT NULL THEN 'yes' ELSE 'NO' END AS persisted_in_tx,
    (SELECT count(*)::int FROM reasoning_logs rl
       WHERE rl.tx_signature = st.tx_signature) AS span_count,
    (SELECT count(*)::int FROM reasoning_logs rl
       WHERE rl.trace_id = st.trace_id) AS trace_span_count,
    tx.instruction_name
  FROM sig_traces st
  LEFT JOIN agent_transactions tx ON tx.signature = st.tx_signature
  ORDER BY st.tx_signature DESC
  LIMIT 10
`);

console.log('\ncorrelated tx (sig → persisted? | spans with sig | full-trace spans | instruction):');
for (const row of correlated) {
  console.log(
    `  ${row.signature.slice(0, 20)}...  persisted=${row.persisted_in_tx}  sig_spans=${row.span_count}  trace_spans=${row.trace_span_count}  instr=${row.instruction_name ?? '-'}`,
  );
}

process.exit(0);
