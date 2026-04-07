/**
 * Seed a single test user + agent so the ingestion worker has at least
 * one wallet to subscribe to. Idempotent — re-running just returns the
 * existing rows. Safe to run multiple times.
 *
 * Usage: DATABASE_URL=... AGENT_WALLET=<base58> pnpm tsx scripts/seed-test-agent.ts
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { agents, users } from '../src/schema';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

// Caller MUST provide a real Solana wallet pubkey via AGENT_WALLET env.
// Earlier versions defaulted to a program ID (SPL Token Program), which
// caused the worker to flood the DB with every token tx on devnet —
// don't do that again.
const wallet = process.env['AGENT_WALLET'];
if (!wallet) {
  console.error('AGENT_WALLET env var is required (Solana base58 wallet pubkey).');
  console.error(
    'Generate one with: solana-keygen new --no-bip39-passphrase --outfile /tmp/test.json',
  );
  console.error('Then: solana-keygen pubkey /tmp/test.json');
  process.exit(1);
}

const db = createDb({ connectionString: url });

async function main() {
  // Use a stable test DID so the upsert is idempotent.
  const privyDid = 'did:privy:test_seed_user';

  const existingUser = await db
    .select()
    .from(users)
    .where(sql`${users.privyDid} = ${privyDid}`)
    .limit(1);

  let userId: string;
  if (existingUser.length > 0 && existingUser[0]) {
    userId = existingUser[0].id;
    console.log('  ↻ user exists', userId);
  } else {
    const inserted = await db
      .insert(users)
      .values({ privyDid, email: 'test@agentscope.dev' })
      .returning({ id: users.id });
    if (!inserted[0]) throw new Error('user insert failed');
    userId = inserted[0].id;
    console.log('  + user created', userId);
  }

  const existingAgent = await db
    .select()
    .from(agents)
    .where(sql`${agents.userId} = ${userId} AND ${agents.walletPubkey} = ${wallet}`)
    .limit(1);

  if (existingAgent.length > 0 && existingAgent[0]) {
    console.log('  ↻ agent exists', existingAgent[0].id, existingAgent[0].walletPubkey);
  } else {
    const inserted = await db
      .insert(agents)
      .values({
        userId,
        walletPubkey: wallet,
        name: 'Test Seed Agent',
        framework: 'custom',
        agentType: 'other',
        ingestToken: `tok_seed_${Date.now()}`,
      })
      .returning({ id: agents.id, walletPubkey: agents.walletPubkey });
    if (!inserted[0]) throw new Error('agent insert failed');
    console.log('  + agent created', inserted[0].id, inserted[0].walletPubkey);
  }

  console.log('\n✅ Seed complete. Wallet to monitor:', wallet);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Seed failed:', err);
    process.exit(1);
  });
