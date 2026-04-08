/**
 * PGlite-backed test database helper.
 *
 * PGlite is PostgreSQL 16 compiled to WebAssembly — same runtime
 * semantics as Supabase (jsonb, uuid, ENUMs, partitions, RLS) without a
 * Docker container. We apply the `@agentscope/db` migration files in
 * order, then hand back a Drizzle client and a cleanup function.
 *
 * The returned client uses the pglite driver, while production routes
 * are typed against the postgres-js driver (`Database` from
 * `@agentscope/db`). Both drivers share the same query-builder surface,
 * so we cast the pglite client to `Database` for tests — a deliberate
 * escape hatch confined to this helper.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'src',
  'migrations',
);

export interface TestDatabase {
  db: Database;
  /** Raw PGlite handle — useful for direct SQL inspection in tests. */
  pg: PGlite;
  /** Close the in-memory database. Call in afterAll/afterEach. */
  close(): Promise<void>;
}

async function applyMigration(pg: PGlite, file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
  // drizzle-kit uses "--> statement-breakpoint" as a literal separator
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await pg.exec(stmt);
  }
}

/**
 * Spin up a fresh PGlite instance with the full AgentScope schema
 * applied. Every test (or test suite) should create its own instance to
 * guarantee isolation — PGlite is in-memory and cheap.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  await pg.waitReady;

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await applyMigration(pg, file);
  }

  // Cast across driver boundaries: pglite and postgres-js drizzle clients
  // share the query-builder surface we rely on in routes, but TypeScript
  // sees them as distinct branded types. Safe at runtime; confined here.
  const db = drizzle(pg) as unknown as Database;

  return {
    db,
    pg,
    async close() {
      await pg.close();
    },
  };
}
