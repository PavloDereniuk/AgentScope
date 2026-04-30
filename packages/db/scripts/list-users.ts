/**
 * List registered users with their Privy DID, creation time, and agent
 * count. Useful when you need to look up your own DID for the
 * `OWNER_PRIVY_DIDS` env var (Epic 14 owner whitelist) or to spot
 * suspicious signup patterns by hand.
 *
 * Hosted DBs require `AGENTSCOPE_ALLOW_PROD_DUMP=1` (see _guard.ts).
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { requireLocalDb } from './_guard';

const url = requireLocalDb('list-users');
const db = createDb({ connectionString: url });

const users = await db.execute<{
  user_id: string;
  privy_did: string;
  created_at: string;
  agent_count: number;
}>(sql`
  SELECT
    u.id::text AS user_id,
    u.privy_did,
    u.created_at::text AS created_at,
    count(a.id)::int AS agent_count
  FROM users u
  LEFT JOIN agents a ON a.user_id = u.id
  GROUP BY u.id
  ORDER BY u.created_at ASC
  LIMIT 50
`);

const agentRows = await db.execute<{
  user_id: string;
  name: string;
  wallet_pubkey: string;
  framework: string;
  created_at: string;
}>(sql`
  SELECT
    user_id::text AS user_id,
    name,
    wallet_pubkey,
    framework,
    created_at::text AS created_at
  FROM agents
  ORDER BY created_at ASC
`);

const agentsByUser = new Map<string, typeof agentRows>();
for (const a of agentRows) {
  const list = agentsByUser.get(a.user_id) ?? [];
  list.push(a);
  agentsByUser.set(a.user_id, list);
}

for (const [i, u] of users.entries()) {
  console.log(`\n[${i + 1}] ${u.privy_did}`);
  console.log(`    created: ${u.created_at}    agents: ${u.agent_count}`);
  const list = agentsByUser.get(u.user_id) ?? [];
  if (list.length === 0) {
    console.log(`    (no agents)`);
    continue;
  }
  for (const a of list) {
    console.log(`      - "${a.name}" [${a.framework}] wallet=${a.wallet_pubkey}`);
  }
}
console.log(`\n${users.length} user(s) shown (oldest first; cap 50).`);
process.exit(0);
