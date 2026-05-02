import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { requireLocalDb } from './_guard';

const url = requireLocalDb('count-tx');

const db = createDb({ connectionString: url });
const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agent_transactions`);
console.log('agent_transactions count:', r[0]?.n);
process.exit(0);
