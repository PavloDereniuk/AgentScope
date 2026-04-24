/**
 * Telegram linking routes (task 14.11).
 *
 * POST /api/telegram/init    — issue a one-time binding code + deep link
 * GET  /api/telegram/status  — poll until the bot resolved the code
 *
 * Pairs with the bot worker in apps/ingestion/src/telegram-bot.ts and the
 * "Link Telegram" button in the dashboard (14.12). The user clicks the
 * deep link, Telegram opens the bot with `/start <code>`, the bot writes
 * `chat_id` + `linked_at` back into `telegram_bindings`, and the
 * dashboard's polling loop sees `linked: true` and prefills the agent's
 * `telegramChatId` field.
 *
 * Security model: the code is short (12 chars) but lives only ~10 min
 * for unlinked rows (TTL gate + janitor). It identifies the *binding*,
 * not the user — even if guessed, the attacker would need to also race
 * the legitimate user to /start with it before linking. Once linked,
 * the chat_id is sticky and second claims are refused at the bot side.
 */

import { randomBytes } from 'node:crypto';
import { type Database, telegramBindings } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const BINDING_TTL_MIN = 10;
/** 9 bytes = 12 base64url chars — short enough for a clean URL, plenty of entropy. */
const BINDING_CODE_BYTES = 9;
/**
 * Bot username surfaces as `t.me/<bot>?start=<code>`. Read at module-init
 * time so a misconfigured deploy fails loudly on the first init request,
 * not silently shipping a useless deep link to the user.
 */
const BOT_USERNAME_ENV = process.env.TELEGRAM_BOT_USERNAME ?? '';

const statusQuerySchema = z.object({
  code: z.string().min(8).max(64),
});

function generateBindingCode(): string {
  return randomBytes(BINDING_CODE_BYTES).toString('base64url');
}

export interface TelegramRouterOptions {
  /**
   * Telegram bot username (without the leading @). Falls back to
   * TELEGRAM_BOT_USERNAME env var. When neither is set, /init returns
   * 503 — the deep link would be unusable, so we'd rather fail loudly
   * than emit `t.me/?start=...` and confuse the user.
   */
  botUsername?: string;
}

export function createTelegramRouter(db: Database, options: TelegramRouterOptions = {}) {
  const botUsername = (options.botUsername ?? BOT_USERNAME_ENV).trim();
  const router = new Hono<ApiEnv>();

  // ── POST /init ──────────────────────────────────────────────────────────
  // Idempotent-ish: a user requesting twice in quick succession gets a new
  // code each time. The previous one stays valid until TTL expiry, so a
  // user double-clicking the button doesn't strand themselves.
  router.post('/init', async (c) => {
    if (!botUsername) {
      throw new HTTPException(503, {
        message: 'telegram bot not configured',
      });
    }

    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);

    // randomBytes collisions are astronomically unlikely (72 bits), but
    // the unique index on binding_code would still 23000 the request if
    // the impossible happens — surface that as 500 by letting it throw.
    const code = generateBindingCode();
    await db.insert(telegramBindings).values({ userId: user.id, bindingCode: code });

    return c.json({
      code,
      deepLink: `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}`,
      expiresInSec: BINDING_TTL_MIN * 60,
    });
  });

  // ── GET /status?code=… ─────────────────────────────────────────────────
  // Used by the dashboard to poll. We scope the lookup to the caller's
  // user_id so a leaked code can't be polled cross-tenant — the worst an
  // attacker could do with someone else's code is /start it themselves
  // (which the bot refuses on second claim).
  router.get(
    '/status',
    zValidator('query', statusQuerySchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid code' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const user = await ensureUser(db, privyDid);
      const { code } = c.req.valid('query');

      const cutoff = new Date(Date.now() - BINDING_TTL_MIN * 60_000).toISOString();

      // Linked rows match unconditionally (no TTL); unlinked rows must
      // still be inside their freshness window. Either way we check
      // user_id so the response can't leak whether someone *else*'s
      // binding exists.
      const [row] = await db
        .select()
        .from(telegramBindings)
        .where(and(eq(telegramBindings.bindingCode, code), eq(telegramBindings.userId, user.id)))
        .limit(1);

      if (!row) return c.json({ linked: false, expired: true });

      if (row.linkedAt && row.chatId) {
        return c.json({ linked: true, chatId: row.chatId });
      }

      // Unlinked + past TTL = effectively gone (janitor will clean up).
      const stillFresh = new Date(row.createdAt) > new Date(cutoff);
      if (!stillFresh) return c.json({ linked: false, expired: true });

      return c.json({ linked: false, expired: false });
    },
  );

  // ── GET /pending ───────────────────────────────────────────────────────
  // Diagnostic: how many live bindings does this user currently have?
  // Saves the dashboard from a re-init storm if the user closes the
  // modal and reopens it (we can show the existing one instead of
  // generating yet another).
  router.get('/pending', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);
    const cutoff = new Date(Date.now() - BINDING_TTL_MIN * 60_000).toISOString();

    const rows = await db
      .select({ id: telegramBindings.id, createdAt: telegramBindings.createdAt })
      .from(telegramBindings)
      .where(
        and(
          eq(telegramBindings.userId, user.id),
          isNull(telegramBindings.linkedAt),
          gt(telegramBindings.createdAt, cutoff),
        ),
      );

    return c.json({ count: rows.length });
  });

  return router;
}
