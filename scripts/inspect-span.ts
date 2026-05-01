/**
 * Diagnostic: dump every column of `reasoning_logs` rows matching a given
 * traceId — including the jsonb `attributes` blob the dashboard does not
 * yet render. Used to verify L0 (`POST /v1/spans`) ingest landed the
 * payload we sent.
 *
 * Run: cd scripts && npx tsx --env-file=../.env inspect-span.ts <traceId>
 *      cd scripts && npx tsx --env-file=../.env inspect-span.ts        # → list 10 most recent
 */

import { agents, createDb, reasoningLogs } from '@agentscope/db';
import { asc, desc, eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const traceId = process.argv[2];
const db = createDb({ connectionString: DATABASE_URL });

console.info(`DB host: ${new URL(DATABASE_URL).hostname}`);

if (!traceId) {
  console.info('\nNo traceId arg — listing 10 most recent spans across all agents:\n');
  const recent = await db
    .select({
      traceId: reasoningLogs.traceId,
      spanId: reasoningLogs.spanId,
      spanName: reasoningLogs.spanName,
      startTime: reasoningLogs.startTime,
      agentName: agents.name,
    })
    .from(reasoningLogs)
    .innerJoin(agents, eq(reasoningLogs.agentId, agents.id))
    .orderBy(desc(reasoningLogs.startTime))
    .limit(10);
  if (recent.length === 0) {
    console.info('  (no spans in reasoning_logs at all)');
    process.exit(0);
  }
  for (const r of recent) {
    console.info(`  ${r.startTime}  ${r.agentName.padEnd(20)}  ${r.spanName.padEnd(20)}  trace=${r.traceId}`);
  }
  process.exit(0);
}

const rows = await db
  .select({
    id: reasoningLogs.id,
    agentId: reasoningLogs.agentId,
    traceId: reasoningLogs.traceId,
    spanId: reasoningLogs.spanId,
    parentSpanId: reasoningLogs.parentSpanId,
    spanName: reasoningLogs.spanName,
    startTime: reasoningLogs.startTime,
    endTime: reasoningLogs.endTime,
    attributes: reasoningLogs.attributes,
    txSignature: reasoningLogs.txSignature,
    agentName: agents.name,
    agentWallet: agents.walletPubkey,
  })
  .from(reasoningLogs)
  .innerJoin(agents, eq(reasoningLogs.agentId, agents.id))
  .where(eq(reasoningLogs.traceId, traceId))
  .orderBy(asc(reasoningLogs.startTime));

if (rows.length === 0) {
  console.error(`\nNo spans found for traceId=${traceId}`);
  process.exit(1);
}

console.info(`\nTrace: ${traceId}`);
console.info(`Spans: ${rows.length}\n`);

for (const r of rows) {
  const startMs = new Date(r.startTime).getTime();
  const endMs = new Date(r.endTime).getTime();
  const durationMs = endMs - startMs;
  console.info('─'.repeat(72));
  console.info(`  span_name      : ${r.spanName}`);
  console.info(`  span_id        : ${r.spanId}`);
  console.info(`  parent_span_id : ${r.parentSpanId ?? '(root)'}`);
  console.info(`  agent          : ${r.agentName} (${r.agentWallet})`);
  console.info(`  agent_id       : ${r.agentId}`);
  console.info(`  start_time     : ${r.startTime}`);
  console.info(`  end_time       : ${r.endTime}`);
  console.info(`  duration_ms    : ${durationMs}`);
  console.info(`  tx_signature   : ${r.txSignature ?? '(none)'}`);
  console.info(`  attributes     :`);
  console.info(JSON.stringify(r.attributes, null, 2).replace(/^/gm, '    '));
}

process.exit(0);
