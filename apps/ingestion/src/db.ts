/**
 * Lazy DB client singleton for the ingestion worker.
 * One pool per worker process — sized to fit Supabase free tier alongside
 * the API and cron services.
 */

import { type Database, createDb } from '@agentscope/db';
import type { Config } from './config';

let cached: Database | null = null;

export function getDb(config: Config): Database {
  if (cached) return cached;
  cached = createDb({
    connectionString: config.DATABASE_URL,
    maxConnections: 5, // ingestion is the heaviest writer; keep room for api+cron
  });
  return cached;
}
