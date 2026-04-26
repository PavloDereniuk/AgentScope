import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { requireLocalDb } from './_guard';

const url = requireLocalDb('show-agent-tokens');

const reveal = process.env['AGENTSCOPE_ALLOW_TOKEN_DUMP'] === '1';
if (reveal) {
  console.warn(
    '[show-agent-tokens] AGENTSCOPE_ALLOW_TOKEN_DUMP=1 — full ingest tokens will be printed. ' +
      'Tokens equal an agent API key; avoid saving shell scrollback.',
  );
}

const db = createDb({ connectionString: url });
const rows = await db.execute<{
  name: string;
  wallet_pubkey: string;
  ingest_token: string;
}>(
  sql`SELECT name, wallet_pubkey, ingest_token FROM agents ORDER BY created_at DESC LIMIT 10`,
);

function mask(token: string): string {
  if (token.length <= 10) return `${token.slice(0, 2)}…`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

for (const r of rows) {
  console.log(`\n${r.name}`);
  console.log(`  wallet: ${r.wallet_pubkey}`);
  console.log(`  token:  ${reveal ? r.ingest_token : mask(r.ingest_token)}`);
}
process.exit(0);
