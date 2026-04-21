/**
 * Diagnostic: list (agent_id, rule_name, dedupe_key) groups with more
 * than one row so we know what migration 0004 will collapse before it
 * creates the UNIQUE index. A clean run means the migration can proceed
 * without data loss concerns.
 *
 * Not part of CI — run manually via tsx.
 */

import { alerts, createDb } from '@agentscope/db';
import { isNotNull, sql } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const db = createDb({ connectionString: DATABASE_URL });

const dupes = await db
  .select({
    agentId: alerts.agentId,
    ruleName: alerts.ruleName,
    dedupeKey: alerts.dedupeKey,
    count: sql<number>`count(*)::int`,
  })
  .from(alerts)
  .where(isNotNull(alerts.dedupeKey))
  .groupBy(alerts.agentId, alerts.ruleName, alerts.dedupeKey)
  .having(sql`count(*) > 1`)
  .orderBy(sql`count(*) desc`);

console.info(`Found ${dupes.length} dedupe-key group(s) with duplicates:`);
let totalRedundant = 0;
for (const d of dupes) {
  const redundant = Number(d.count) - 1;
  totalRedundant += redundant;
  console.info(
    `  agent=${d.agentId}  rule=${d.ruleName}  key=${d.dedupeKey}  count=${d.count}  (will delete ${redundant})`,
  );
}
console.info(`\nTotal rows the migration will delete: ${totalRedundant}`);

process.exit(0);
