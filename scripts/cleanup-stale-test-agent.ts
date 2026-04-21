/**
 * One-shot: delete the "Stale test agent" (id hard-coded below) and its
 * alerts. Used to clean up after the cron → Telegram delivery live test.
 *
 * Not part of CI — run manually via tsx.
 */

import { agents, alerts, createDb } from '@agentscope/db';
import { eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const AGENT_ID = process.argv[2] ?? '1016f59d-6964-4f2f-b38c-bebcf9e2ac5c';

const db = createDb({ connectionString: DATABASE_URL });

const deletedAlerts = await db
  .delete(alerts)
  .where(eq(alerts.agentId, AGENT_ID))
  .returning({ id: alerts.id });

console.info(`Deleted ${deletedAlerts.length} alert(s) for agent ${AGENT_ID}`);

const deletedAgent = await db
  .delete(agents)
  .where(eq(agents.id, AGENT_ID))
  .returning({ id: agents.id, name: agents.name });

if (deletedAgent.length === 0) {
  console.info(`Agent ${AGENT_ID} not found (already deleted?)`);
} else {
  for (const a of deletedAgent) {
    console.info(`Deleted agent: ${a.name} (${a.id})`);
  }
}

process.exit(0);
