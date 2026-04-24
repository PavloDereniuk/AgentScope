/**
 * Unit + integration tests for the Telegram bot worker (task 14.10).
 *
 * Drives `processUpdate` and `pruneExpiredBindings` against a real
 * PGlite-backed schema; the long-poll loop itself is not exercised
 * here (it would mean stubbing Telegram's HTTP endpoint, with little
 * extra confidence — the loop is just a thin while + fetch wrapper).
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Database, telegramBindings, users } from '@agentscope/db';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processUpdate, pruneExpiredBindings } from '../src/telegram-bot';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'packages', 'db', 'src', 'migrations');

const silentLogger = {
  error: () => {},
  info: () => {},
  warn: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Parameters<typeof processUpdate>[3];

let db: Database;
let pg: PGlite;
let userId: string;

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

  const [user] = await db.insert(users).values({ privyDid: 'did:privy:tg-bot-test' }).returning();
  if (!user) throw new Error('seed user failed');
  userId = user.id;
});

afterAll(async () => {
  await pg.close();
});

function update(text: string, chatId = 555_001, chatType = 'private') {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 1,
      from: { id: chatId, first_name: 'Tester' },
      chat: { id: chatId, type: chatType },
      text,
    },
  };
}

describe('processUpdate', () => {
  it('links a fresh binding code and writes chat_id', async () => {
    const code = `code-${Date.now()}-a`;
    await db.insert(telegramBindings).values({ userId, bindingCode: code });

    const result = await processUpdate(db, update(`/start ${code}`, 12345), 10, silentLogger);

    expect(result.linked).toBe(true);
    expect(result.replyText).toMatch(/Linked/);
    expect(result.replyChatId).toBe(12345);

    const [row] = await db
      .select()
      .from(telegramBindings)
      .where(eq(telegramBindings.bindingCode, code));
    expect(row?.chatId).toBe('12345');
    expect(row?.linkedAt).not.toBeNull();
  });

  it('rejects an expired binding code', async () => {
    const code = `code-${Date.now()}-expired`;
    // Insert with created_at 20 min in the past — past the 10 min TTL.
    await pg.exec(
      `INSERT INTO telegram_bindings (user_id, binding_code, created_at)
       VALUES ('${userId}', '${code}', now() - interval '20 minutes')`,
    );

    const result = await processUpdate(db, update(`/start ${code}`), 10, silentLogger);

    expect(result.linked).toBe(false);
    expect(result.replyText).toMatch(/expired/);
  });

  it('returns helpful message for /start without a code', async () => {
    const result = await processUpdate(db, update('/start'), 10, silentLogger);
    expect(result.linked).toBe(false);
    expect(result.replyText).toMatch(/dashboard/);
  });

  it('returns expired message for unknown code', async () => {
    const result = await processUpdate(db, update('/start nonsense'), 10, silentLogger);
    expect(result.linked).toBe(false);
    expect(result.replyText).toMatch(/expired or is invalid/);
  });

  it('ignores non-/start messages', async () => {
    const result = await processUpdate(db, update('hello bot'), 10, silentLogger);
    expect(result.linked).toBe(false);
    expect(result.replyText).toBeUndefined();
  });

  it('ignores group chats', async () => {
    const code = `code-${Date.now()}-group`;
    await db.insert(telegramBindings).values({ userId, bindingCode: code });
    const result = await processUpdate(
      db,
      update(`/start ${code}`, 999, 'group'),
      10,
      silentLogger,
    );
    expect(result.linked).toBe(false);
    // No reply at all — we don't want to confirm bot presence in a random group.
    expect(result.replyText).toBeUndefined();
  });

  it('replies "already linked" idempotently for the same chat', async () => {
    const code = `code-${Date.now()}-idem`;
    await db.insert(telegramBindings).values({ userId, bindingCode: code });
    await processUpdate(db, update(`/start ${code}`, 7777), 10, silentLogger);

    const second = await processUpdate(db, update(`/start ${code}`, 7777), 10, silentLogger);
    expect(second.linked).toBe(true);
    expect(second.replyText).toMatch(/Already linked/);
  });

  it('refuses second claim from a different chat', async () => {
    const code = `code-${Date.now()}-claim`;
    await db.insert(telegramBindings).values({ userId, bindingCode: code });
    await processUpdate(db, update(`/start ${code}`, 11111), 10, silentLogger);

    const stolen = await processUpdate(db, update(`/start ${code}`, 22222), 10, silentLogger);
    expect(stolen.linked).toBe(false);
    expect(stolen.replyText).toMatch(/already been used/);

    const [row] = await db
      .select()
      .from(telegramBindings)
      .where(eq(telegramBindings.bindingCode, code));
    expect(row?.chatId).toBe('11111');
  });
});

describe('pruneExpiredBindings', () => {
  it('deletes only unlinked rows past the TTL', async () => {
    const fresh = `prune-${Date.now()}-fresh`;
    const stale = `prune-${Date.now()}-stale`;
    const linked = `prune-${Date.now()}-linked`;

    await db.insert(telegramBindings).values({ userId, bindingCode: fresh });
    await pg.exec(
      `INSERT INTO telegram_bindings (user_id, binding_code, created_at)
       VALUES ('${userId}', '${stale}', now() - interval '20 minutes')`,
    );
    await pg.exec(
      `INSERT INTO telegram_bindings (user_id, binding_code, created_at, linked_at, chat_id)
       VALUES ('${userId}', '${linked}', now() - interval '60 minutes', now() - interval '60 minutes', '999')`,
    );

    const deleted = await pruneExpiredBindings(db, 10);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.select().from(telegramBindings);
    const codes = remaining.map((r) => r.bindingCode);
    expect(codes).toContain(fresh);
    expect(codes).toContain(linked);
    expect(codes).not.toContain(stale);
  });
});
