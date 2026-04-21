/**
 * Diagnostic: print the 10 most recent mainnet tx for Trade bot 1 so we
 * can decide whether backfill will bump last_seen_at into fresh-land
 * (breaking the stale_agent test).
 */

import { agentTransactions, agents, createDb } from '@agentscope/db';
import { desc, eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

const db = createDb({ connectionString: DATABASE_URL });

const [agent] = await db
  .select({ id: agents.id, wallet: agents.walletPubkey })
  .from(agents)
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .limit(1);

if (!agent) throw new Error('agent not found');
console.info(`Agent: ${agent.id} wallet=${agent.wallet}`);

const rows = await db
  .select({
    signature: agentTransactions.signature,
    blockTime: agentTransactions.blockTime,
    instructionName: agentTransactions.instructionName,
  })
  .from(agentTransactions)
  .where(eq(agentTransactions.agentId, agent.id))
  .orderBy(desc(agentTransactions.blockTime))
  .limit(10);

console.info(`\n${rows.length} most recent tx (newest first):`);
for (const r of rows) {
  const ageMin = Math.floor(
    (Date.now() - new Date(r.blockTime).getTime()) / 60_000,
  );
  console.info(
    `  ${r.blockTime}  (${ageMin}m ago)  ${r.instructionName ?? '(none)'}  ${r.signature.slice(0, 20)}...`,
  );
}

process.exit(0);
