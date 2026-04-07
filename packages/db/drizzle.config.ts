import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL must be set when running drizzle-kit (db:generate / db:migrate / db:push)',
  );
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url,
  },
  verbose: true,
  strict: true,
});
