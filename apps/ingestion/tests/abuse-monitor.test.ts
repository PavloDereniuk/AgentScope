/**
 * Unit tests for the abuse signup-spike monitor (Epic 14 Phase 3 task
 * 14.16). Covers the pure cooldown gate plus one DB-backed cycle so the
 * shouldAlert → runAbuseCheck → sendAdminMessage wiring stays honest.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, users } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAbuseCheck, shouldAlert } from '../src/abuse-monitor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const silentLogger = { error: () => {}, info: () => {}, warn: () => {} };

describe('shouldAlert (pure cooldown gate)', () => {
  const threshold = 10;
  const cooldownMs = 30 * 60_000;

  it('does not fire when count is below threshold', () => {
    expect(shouldAlert(9, threshold, null, 0, cooldownMs)).toBe(false);
  });

  it('fires when count hits threshold and no prior alert', () => {
    expect(shouldAlert(10, threshold, null, 0, cooldownMs)).toBe(true);
    expect(shouldAlert(42, threshold, null, 0, cooldownMs)).toBe(true);
  });

  it('suppresses repeat within cooldown', () => {
    const lastAlertAt = 1_000_000;
    const now = lastAlertAt + cooldownMs - 1;
    expect(shouldAlert(15, threshold, lastAlertAt, now, cooldownMs)).toBe(false);
  });

  it('fires again after cooldown elapses', () => {
    const lastAlertAt = 1_000_000;
    const now = lastAlertAt + cooldownMs;
    expect(shouldAlert(15, threshold, lastAlertAt, now, cooldownMs)).toBe(true);
  });
});

describe('runAbuseCheck (integration)', () => {
  let db: Database;
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.waitReady;
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of stmts) {
        await pg.exec(stmt);
      }
    }
    db = drizzle(pg) as unknown as Database;
  });

  afterAll(async () => {
    await pg.close();
  });

  it('sends one admin message when 10 users land inside the window', async () => {
    // Seed: 11 users created within the last 2 minutes.
    const now = Date.now();
    const rows = Array.from({ length: 11 }, (_, i) => ({
      privyDid: `did:privy:spike-${i}-${now}`,
      createdAt: new Date(now - 60_000).toISOString(),
    }));
    await db.insert(users).values(rows);

    const sent: string[] = [];
    const state = { lastAlertAt: null as number | null };
    await runAbuseCheck(
      {
        db,
        logger: silentLogger,
        sendAdminMessage: async (text) => {
          sent.push(text);
        },
        threshold: 10,
        windowMs: 10 * 60_000,
        cooldownMs: 30 * 60_000,
      },
      state,
      now,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/abuse signal/i);
    expect(sent[0]).toMatch(/\b11 new users\b/);
    expect(state.lastAlertAt).toBe(now);

    // Second call within cooldown → no duplicate.
    await runAbuseCheck(
      {
        db,
        logger: silentLogger,
        sendAdminMessage: async (text) => {
          sent.push(text);
        },
        threshold: 10,
        windowMs: 10 * 60_000,
        cooldownMs: 30 * 60_000,
      },
      state,
      now + 60_000,
    );
    expect(sent).toHaveLength(1);
  });
});
