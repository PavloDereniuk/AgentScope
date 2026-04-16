import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb({ connectionString: url });
const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agent_transactions`);
console.log('agent_transactions count:', r[0]?.n);
process.exit(0);
