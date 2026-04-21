/**
 * One-shot: backdate Trade bot 1's last_seen_at by 90 minutes so the
 * stale_agent rule fires on the next cron tick. Used to validate the
 * cron → alerter → Telegram delivery path end-to-end.
 *
 * Not part of CI — run manually via tsx.
 */

import { agents, createDb } from '@agentscope/db';
import { eq, sql } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

const db = createDb({ connectionString: DATABASE_URL });

const updated = await db
  .update(agents)
  .set({ lastSeenAt: sql`now() - interval '90 minutes'`, status: 'live' })
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .returning({ id: agents.id, name: agents.name, lastSeenAt: agents.lastSeenAt });

for (const a of updated) {
  console.info(`Backdated ${a.name} (${a.id}) → last_seen_at=${a.lastSeenAt}`);
}

process.exit(0);
