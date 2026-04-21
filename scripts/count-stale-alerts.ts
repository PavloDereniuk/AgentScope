/**
 * Diagnostic: print just the count of stale_agent alerts for a given
 * agent id. Intended for polling (e.g. from a Monitor loop).
 * Prints a single integer on stdout.
 *
 * Not part of CI — run manually via tsx.
 */

import { alerts, createDb } from '@agentscope/db';
import { and, eq, sql } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const AGENT_ID = process.argv[2];
if (!AGENT_ID) throw new Error('pass agent id as argv[2]');

const db = createDb({ connectionString: DATABASE_URL });

const [row] = await db
  .select({ c: sql<number>`count(*)::int` })
  .from(alerts)
  .where(and(eq(alerts.agentId, AGENT_ID), eq(alerts.ruleName, 'stale_agent')));

console.log(row?.c ?? 0);

process.exit(0);
