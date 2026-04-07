import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';

const db = createDb({ connectionString: process.env['DATABASE_URL'] ?? '' });
const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM agent_transactions`);
console.log('agent_transactions count:', r[0]?.n);
process.exit(0);
