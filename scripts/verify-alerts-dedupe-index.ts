/**
 * Diagnostic: print the current indexes on the `alerts` table so we can
 * confirm migration 0004 replaced the plain `alerts_dedupe_idx` with a
 * UNIQUE `alerts_dedupe_unique` index covering (agent_id, rule_name,
 * dedupe_key).
 *
 * Not part of CI — run manually via tsx.
 */

import { createDb } from '@agentscope/db';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const db = createDb({ connectionString: DATABASE_URL });

const rows = await db.execute(sql`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE tablename = 'alerts' AND schemaname = 'public'
  ORDER BY indexname;
`);

console.info('Indexes on "alerts":');
for (const r of rows) {
  const indexname = (r as { indexname: string }).indexname;
  const indexdef = (r as { indexdef: string }).indexdef;
  const isUnique = indexdef.toLowerCase().includes('unique');
  console.info(`  ${isUnique ? '[U] ' : '    '}${indexname}`);
  console.info(`      ${indexdef}`);
}

process.exit(0);
