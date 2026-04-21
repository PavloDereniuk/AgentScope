import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb({ connectionString: url });
const rows = await db.execute<{
  name: string;
  wallet_pubkey: string;
  ingest_token: string;
}>(
  sql`SELECT name, wallet_pubkey, ingest_token FROM agents ORDER BY created_at DESC LIMIT 10`,
);

for (const r of rows) {
  console.log(`\n${r.name}`);
  console.log(`  wallet: ${r.wallet_pubkey}`);
  console.log(`  token:  ${r.ingest_token}`);
}
process.exit(0);
