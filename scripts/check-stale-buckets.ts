/**
 * One-shot diagnostic: list existing stale_agent alerts for Trade bot 1
 * and report the current hour-bucket dedupe key so we know whether the
 * next cron tick will fire a fresh alert or dedupe-skip.
 *
 * Not part of CI — run manually via tsx.
 */

import { agents, alerts, createDb } from '@agentscope/db';
import { and, desc, eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

const db = createDb({ connectionString: DATABASE_URL });

const [agent] = await db
  .select({ id: agents.id, name: agents.name, lastSeenAt: agents.lastSeenAt, status: agents.status })
  .from(agents)
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .limit(1);

if (!agent) throw new Error('agent not found');

console.info('Agent:', agent);

const now = new Date();
const nowMs = now.getTime();
// Matches packages/detector/src/rules/stale.ts — bucket width is max(threshold, 60) min.
const bucketMs = 60 * 60_000;
const currentBucket = Math.floor(nowMs / bucketMs);
const expectedDedupeKey = `stale:${agent.id}:${currentBucket}`;

console.info(
  `Now (UTC): ${now.toISOString()} | hour-bucket index: ${currentBucket} | expected dedupeKey: ${expectedDedupeKey}`,
);

const staleRows = await db
  .select({
    id: alerts.id,
    dedupeKey: alerts.dedupeKey,
    triggeredAt: alerts.triggeredAt,
    deliveryStatus: alerts.deliveryStatus,
  })
  .from(alerts)
  .where(and(eq(alerts.agentId, agent.id), eq(alerts.ruleName, 'stale_agent')))
  .orderBy(desc(alerts.triggeredAt))
  .limit(10);

console.info(`\n${staleRows.length} stale_agent alerts for this agent (most recent 10):`);
for (const r of staleRows) {
  const isCurrent = r.dedupeKey === expectedDedupeKey ? '  ← CURRENT BUCKET (will dedupe)' : '';
  console.info(
    `  ${r.triggeredAt}  status=${r.deliveryStatus}  key=${r.dedupeKey ?? '(null)'}${isCurrent}`,
  );
}

if (staleRows.some((r) => r.dedupeKey === expectedDedupeKey)) {
  console.info('\n⚠️  Current hour-bucket is already taken. Wait until the next UTC hour for a fresh fire.');
  const nextBucketStart = new Date((currentBucket + 1) * bucketMs);
  console.info(`   Next bucket starts at: ${nextBucketStart.toISOString()}`);
} else {
  console.info('\n✓ Current hour-bucket is free. Starting ingestion will fire a fresh stale alert on the next 60s cron tick.');
}

process.exit(0);
