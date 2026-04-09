/**
 * PGlite test database helper for detector tests.
 * Same pattern as apps/api/tests/helpers/test-db.ts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'src', 'migrations');

export interface TestDatabase {
  db: Database;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.waitReady;

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }

  const db = drizzle(pg) as unknown as Database;
  return {
    db,
    async close() {
      await pg.close();
    },
  };
}
