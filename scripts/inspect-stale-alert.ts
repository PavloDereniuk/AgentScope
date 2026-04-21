import { agents, alerts, createDb } from '@agentscope/db';
import { and, desc, eq } from 'drizzle-orm';

const AGENT_ID = process.argv[2];
if (!AGENT_ID) throw new Error('pass agent id as argv[2]');

const db = createDb({ connectionString: process.env['DATABASE_URL'] ?? '' });

const rows = await db
  .select()
  .from(alerts)
  .where(and(eq(alerts.agentId, AGENT_ID), eq(alerts.ruleName, 'stale_agent')))
  .orderBy(desc(alerts.triggeredAt));

console.info(JSON.stringify(rows, null, 2));

const [agent] = await db
  .select({ status: agents.status, name: agents.name })
  .from(agents)
  .where(eq(agents.id, AGENT_ID));

console.info('Agent:', JSON.stringify(agent));

process.exit(0);
