/**
 * One-shot: create a fresh "stale test" agent with a brand-new (never-used)
 * wallet pubkey so the stale_agent rule fires on the next cron tick via
 * its `never` branch — no history, no live WS traffic, no demo-trader
 * interference. Prints the agent id so we can delete it after the test.
 *
 * Not part of CI — run manually via tsx.
 */

import { randomBytes } from 'node:crypto';
import { agents, createDb } from '@agentscope/db';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';

const DATABASE_URL = process.env['DATABASE_URL'];
const AGENT_TOKEN = process.env['AGENTSCOPE_AGENT_TOKEN_TRADER'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AGENT_TOKEN) throw new Error('AGENTSCOPE_AGENT_TOKEN_TRADER is required');

const db = createDb({ connectionString: DATABASE_URL });

// Reuse Trade bot 1's user so the test agent is visible in the same
// Privy session (no cross-tenant leakage).
const [owner] = await db
  .select({ userId: agents.userId })
  .from(agents)
  .where(eq(agents.ingestToken, AGENT_TOKEN))
  .limit(1);

if (!owner) throw new Error('could not locate Trade bot 1 to borrow user id');

const wallet = Keypair.generate().publicKey.toBase58();
const ingestToken = `tok_${randomBytes(24).toString('base64url')}`;

const [created] = await db
  .insert(agents)
  .values({
    userId: owner.userId,
    walletPubkey: wallet,
    name: 'Stale test agent',
    framework: 'custom',
    agentType: 'other',
    ingestToken,
  })
  .returning({ id: agents.id, name: agents.name, walletPubkey: agents.walletPubkey });

if (!created) throw new Error('agent insert returned no row');

console.info(`Created: ${created.name}`);
console.info(`  id:     ${created.id}`);
console.info(`  wallet: ${created.walletPubkey}  (freshly generated, never used)`);
console.info(`  token:  ${ingestToken}`);
console.info('\nCron will fire stale_agent via the `never` branch on the next 60s tick.');
console.info(`To cleanup: DELETE FROM agents WHERE id = '${created.id}';`);

process.exit(0);
