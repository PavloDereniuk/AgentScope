import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');
const db = createDb({ connectionString: url });

const WALLET = '8h9SSbj4GqUhmUENQpLNvt1LBPwveLLYobCSbZs6r75U';
const r = await db.execute<{ n: number; latest: string | null }>(sql`
  SELECT count(*)::int AS n, max(block_time)::text AS latest
  FROM agent_transactions t
  JOIN agents a ON a.id = t.agent_id
  WHERE a.wallet_pubkey = ${WALLET}
`);
console.log(JSON.stringify(r[0]));

const rows = await db.execute<{ signature: string; block_time: string }>(sql`
  SELECT signature, block_time::text
  FROM agent_transactions t
  JOIN agents a ON a.id = t.agent_id
  WHERE a.wallet_pubkey = ${WALLET}
  ORDER BY block_time DESC LIMIT 30
`);
for (const x of rows) console.log(x.block_time + '  ' + x.signature.slice(0, 16) + '…');
process.exit(0);
