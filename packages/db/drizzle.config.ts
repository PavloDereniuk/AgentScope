import { defineConfig } from 'drizzle-kit';

/**
 * `db:generate` only needs the schema file — no DB connection.
 * `db:migrate` / `db:push` / `db:studio` will fail loudly inside drizzle-kit
 * if DATABASE_URL is missing, which is the better place for that error.
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
