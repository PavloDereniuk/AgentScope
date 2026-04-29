/**
 * Agents CRUD routes (tasks 3.5 → 3.9).
 *
 * 3.5 — POST   /api/agents           create a new agent
 * 3.6 — GET    /api/agents           list agents for the authenticated user
 * 3.7 — GET    /api/agents/:id       single agent + recent_tx_count + last_alert
 * 3.8 — PATCH  /api/agents/:id       partial update (name/tags/webhookUrl/alertRules)
 * 3.9 — DELETE /api/agents/:id       cascade delete via FK
 *
 * Every route expects `c.var.userId` (a Privy DID) populated by
 * `requireAuth`, and looks up the real `users.id` via `ensureUser`
 * before touching owner-scoped tables. The `user_id` on every inserted
 * row is taken from the token, never from the request body.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AlertMessage,
  type DeliverDeps,
  type DeliveryResult,
  createWebhookSender,
  deliver,
} from '@agentscope/alerter';
import { type Database, agentTransactions, agents, alerts, reasoningLogs } from '@agentscope/db';
import { createAgentInputSchema, updateAgentInputSchema } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { decodeTxCursor, encodeTxCursor } from '../lib/cursor';
import type { SseBus } from '../lib/sse-bus';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';
import { NOOP_RATE_LIMITER, type RateLimiter, rateLimitMiddleware } from '../middleware/rate-limit';

/**
 * Opaque token issued to an agent's OTel exporter. 192 bits of entropy
 * encoded as base64url — URL-safe, fits into an `Authorization` header
 * without escaping.
 */
function generateIngestToken(): string {
  return `tok_${randomBytes(24).toString('base64url')}`;
}

/**
 * Rolling window used by `recent_tx_count` on agent detail. 24h is the
 * standard dashboard default — consistent with what Datadog/Grafana use
 * for "recent activity" cards, and short enough to be meaningful for a
 * bot that's stuck or idle.
 */
const RECENT_TX_WINDOW_MS = 24 * 60 * 60 * 1000;

const agentIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * Public projection for read/update responses. `ingestToken` is omitted
 * so the secret only crosses the wire once, on POST /agents (the user
 * needs it to configure their OTel exporter). Every subsequent response
 * — list, detail, patch — uses this projection so the token can never
 * be re-fetched by an authenticated client.
 */
const AGENT_PUBLIC_COLUMNS = {
  id: agents.id,
  userId: agents.userId,
  walletPubkey: agents.walletPubkey,
  name: agents.name,
  framework: agents.framework,
  agentType: agents.agentType,
  status: agents.status,
  tags: agents.tags,
  webhookUrl: agents.webhookUrl,
  telegramChatId: agents.telegramChatId,
  alertRules: agents.alertRules,
  createdAt: agents.createdAt,
  lastSeenAt: agents.lastSeenAt,
} as const;

/** Max page size for the transactions list endpoint (task 3.10). */
const MAX_TX_PAGE_LIMIT = 100;
const DEFAULT_TX_PAGE_LIMIT = 50;

const txListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_TX_PAGE_LIMIT).default(DEFAULT_TX_PAGE_LIMIT),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  // Compare epoch ms, not raw strings — z.datetime({offset:true}) accepts
  // both Z and ±HH:MM suffixes so text-compare is not canonical.
  .refine((q) => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), {
    message: 'from must be <= to',
    path: ['from'],
  });

/**
 * Options grouping the abuse-hardening knobs for the agents router
 * (Epic 14 Phase 3). Separate from the positional primary deps so tests
 * can opt-in selectively without threading `undefined` through.
 */
export interface AgentsRouterOptions {
  /**
   * Hard cap on agents one Privy user can own. Enforced server-side
   * before the INSERT in POST /. Omitted (or positive infinity) means
   * no cap — tests can create unlimited agents without overriding env.
   */
  maxAgentsPerUser?: number;
  /**
   * Per-IP rate limiter mounted as the *first* middleware on POST / so
   * signup floods from one IP are rejected before they consume the
   * per-user budget. Key derivation lives in this module (x-forwarded-
   * for → cf-connecting-ip → null). Absent → no IP throttling.
   */
  ipLimiter?: RateLimiter;
}

/**
 * Extract the best-guess client IP from the request. Railway sits
 * behind its own proxy and exposes the chain via `x-forwarded-for`
 * (first entry is the originating client); Cloudflare-fronted deploys
 * use `cf-connecting-ip`. Returns `null` when neither header is set —
 * the middleware treats that as "skip limiter", so the per-user cap
 * remains the last line of defense.
 */
function getClientIp(c: Context<ApiEnv>): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();
  return null;
}

export function createAgentsRouter(
  db: Database,
  sseBus: SseBus,
  alerter?: DeliverDeps,
  /**
   * Optional rate limiter for `POST /`. Defaults to no limit when
   * undefined — `app.ts` wires up a 10/hour-per-user limiter in
   * production. Tests omit it for fast batch seeding.
   */
  createLimiter?: RateLimiter,
  options: AgentsRouterOptions = {},
) {
  const router = new Hono<ApiEnv>();
  const maxAgentsPerUser = options.maxAgentsPerUser ?? Number.POSITIVE_INFINITY;

  router.post(
    '/',
    // 14.15 — IP layer sits *before* the per-user limiter so one IP
    // rotating through fresh Privy DIDs can't slip past the budget by
    // minting new userIds between requests.
    rateLimitMiddleware(options.ipLimiter ?? NOOP_RATE_LIMITER, getClientIp),
    rateLimitMiddleware(createLimiter ?? NOOP_RATE_LIMITER, (c) => c.get('userId') ?? null),
    zValidator('json', createAgentInputSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const body = c.req.valid('json');

      const user = await ensureUser(db, privyDid);

      // 14.14 — hard cap per user. Checked *after* ensureUser so the
      // count includes a brand-new user's zero-row state (first agent
      // always allowed). The window is non-atomic with the INSERT —
      // concurrent requests from the same user could in theory both
      // pass the count check and land two rows over the cap. At MVP
      // scale (one browser, few clicks) this is acceptable; tightening
      // would require a `SELECT ... FOR UPDATE` or a Postgres
      // check-by-trigger, both overkill for a defense-in-depth cap
      // whose real job is to stop 100× signups, not 3rd-agent races.
      if (Number.isFinite(maxAgentsPerUser)) {
        const [row] = await db
          .select({ count: sql<number>`cast(count(*) as int)` })
          .from(agents)
          .where(eq(agents.userId, user.id));
        const current = row?.count ?? 0;
        if (current >= maxAgentsPerUser) {
          throw new HTTPException(403, {
            message: `agent limit reached (${maxAgentsPerUser} per user)`,
          });
        }
      }

      const [agent] = await db
        .insert(agents)
        .values({
          userId: user.id,
          walletPubkey: body.walletPubkey,
          name: body.name,
          framework: body.framework,
          agentType: body.agentType,
          tags: body.tags ? [...body.tags] : [],
          webhookUrl: body.webhookUrl ?? null,
          telegramChatId: body.telegramChatId ?? null,
          alertRules: body.alertRules ?? {},
          ingestToken: generateIngestToken(),
        })
        .returning();

      if (!agent) {
        throw new HTTPException(500, { message: 'agent insert returned no row' });
      }
      return c.json({ agent }, 201);
    },
  );

  // 3.6 — List all agents owned by the authenticated user, newest first.
  // ingestToken is intentionally omitted — it is only needed when
  // configuring the OTel exporter, not for the list view.
  //
  // 13.3 enriched each row with 24h aggregates so the dashboard can show
  // per-agent tx count, PnL and success rate without a round-trip per row.
  // The stats query runs once with GROUP BY agent_id over all of the user's
  // agents — cheaper and simpler than correlated subqueries or LEFT JOIN
  // LATERAL.
  router.get('/', async (c) => {
    const privyDid = c.get('userId');
    const user = await ensureUser(db, privyDid);

    const rows = await db
      .select(AGENT_PUBLIC_COLUMNS)
      .from(agents)
      .where(eq(agents.userId, user.id))
      .orderBy(desc(agents.createdAt))
      .limit(200); // safety cap; cursor pagination post-MVP

    const since = new Date(Date.now() - RECENT_TX_WINDOW_MS).toISOString();
    const statsRows = await db
      .select({
        agentId: agentTransactions.agentId,
        recentTxCount24h: sql<number>`cast(count(*) as int)`,
        solDelta24h: sql<string>`coalesce(sum(${agentTransactions.solDelta}), 0)::text`,
        successCount24h: sql<number>`cast(count(*) filter (where ${agentTransactions.success}) as int)`,
      })
      .from(agentTransactions)
      .innerJoin(agents, eq(agentTransactions.agentId, agents.id))
      .where(and(eq(agents.userId, user.id), gte(agentTransactions.blockTime, since)))
      .groupBy(agentTransactions.agentId);

    const statsByAgent = new Map(statsRows.map((s) => [s.agentId, s]));

    const enriched = rows.map((row) => {
      const s = statsByAgent.get(row.id);
      const txCount = s?.recentTxCount24h ?? 0;
      const successCount = s?.successCount24h ?? 0;
      return {
        ...row,
        recentTxCount24h: txCount,
        solDelta24h: s?.solDelta24h ?? '0',
        successRate24h: txCount > 0 ? successCount / txCount : null,
      };
    });

    // Expose the per-user cap so the dashboard can proactively hide
    // the "Register agent" button at cap instead of letting the user
    // click through to a 403. `null` means unlimited (tests; omitted
    // env var would yield the default 2, not infinity, in production).
    const maxAgents = Number.isFinite(maxAgentsPerUser) ? maxAgentsPerUser : null;
    return c.json({ agents: enriched, maxAgents });
  });

  // 3.7 — Single agent + recent_tx_count (24h window) + last_alert.
  // Uses an ownership-scoped WHERE so an unauthorized id looks the same
  // as a non-existent one (both → 404, no existence oracle).
  router.get(
    '/:id',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);

      // ingestToken is intentionally included here — this is the single
      // owner-scoped detail endpoint the dashboard settings page uses to
      // surface the token to its owner (copy-to-clipboard for OTel exporter
      // setup). The list endpoint omits it on purpose (fewer exposures,
      // many-agent cache surface). A dedicated reveal endpoint with an
      // explicit confirmation step is tracked for post-MVP.
      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!agent) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      const since = new Date(Date.now() - RECENT_TX_WINDOW_MS).toISOString();
      const [txCountRow] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(agentTransactions)
        .where(
          and(eq(agentTransactions.agentId, agentId), gte(agentTransactions.blockTime, since)),
        );
      const recentTxCount = txCountRow?.count ?? 0;

      const [lastAlert] = await db
        .select()
        .from(alerts)
        .where(eq(alerts.agentId, agentId))
        .orderBy(desc(alerts.triggeredAt))
        .limit(1);

      return c.json({
        agent,
        recentTxCount,
        lastAlert: lastAlert ?? null,
      });
    },
  );

  // 3.8 — Partial update. Only name/tags/webhookUrl/alertRules are
  // mutable; framework, walletPubkey, ingestToken and lifecycle fields
  // are intentionally omitted from the input schema, so zod strips any
  // such keys before the UPDATE ever runs. An empty body is accepted
  // and returns the current row unchanged (idempotent / no-op).
  router.patch(
    '/:id',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    zValidator('json', updateAgentInputSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');
      const body = c.req.valid('json');

      const user = await ensureUser(db, privyDid);

      // Build a SET clause only from keys that were actually present
      // in the request. Unset keys are left untouched — this is what
      // makes PATCH genuinely partial.
      type AgentPatch = Partial<
        Pick<
          typeof agents.$inferInsert,
          'name' | 'tags' | 'webhookUrl' | 'telegramChatId' | 'alertRules'
        >
      >;
      const patch: AgentPatch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.tags !== undefined) patch.tags = [...body.tags];
      if (body.webhookUrl !== undefined) patch.webhookUrl = body.webhookUrl;
      if (body.telegramChatId !== undefined) patch.telegramChatId = body.telegramChatId;
      if (body.alertRules !== undefined) patch.alertRules = body.alertRules;

      // Empty body → no-op. Fetch and return current state so clients
      // get a consistent `{agent}` response regardless of payload.
      if (Object.keys(patch).length === 0) {
        const [current] = await db
          .select(AGENT_PUBLIC_COLUMNS)
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
          .limit(1);
        if (!current) {
          throw new HTTPException(404, { message: 'agent not found' });
        }
        return c.json({ agent: current });
      }

      const [updated] = await db
        .update(agents)
        .set(patch)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .returning(AGENT_PUBLIC_COLUMNS);
      if (!updated) {
        throw new HTTPException(404, { message: 'agent not found' });
      }
      return c.json({ agent: updated });
    },
  );

  // 3.10 — Paginated transactions for an agent. Keyset pagination
  // ordered newest-first by (block_time, id). The cursor is an opaque
  // base64url blob produced by encodeTxCursor; clients treat it as
  // atomic and just pass it back unchanged.
  router.get(
    '/:id/transactions',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    zValidator('query', txListQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');
      const { cursor, limit, from, to } = c.req.valid('query');

      const user = await ensureUser(db, privyDid);

      // Ownership check — a missing or foreign agent returns 404
      // without leaking existence, same as GET/PATCH/DELETE :id.
      const [owned] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!owned) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      // Build the seek condition. Time filters (from/to) apply on
      // every request; the cursor (if present) carves out the "strictly
      // earlier than last seen" half of the result set.
      const where = [eq(agentTransactions.agentId, agentId)];
      if (from) where.push(gte(agentTransactions.blockTime, from));
      if (to) where.push(lte(agentTransactions.blockTime, to));

      if (cursor) {
        const decoded = decodeTxCursor(cursor);
        if (!decoded) {
          throw new HTTPException(422, { message: 'invalid cursor' });
        }
        // (block_time, id) < (cursor.t, cursor.i), expanded to two
        // drizzle conditions for readability. Tuple comparison would
        // also work but requires raw sql template.
        where.push(
          or(
            lt(agentTransactions.blockTime, decoded.t),
            and(eq(agentTransactions.blockTime, decoded.t), lt(agentTransactions.id, decoded.i)),
          ) as ReturnType<typeof lt>,
        );
      }

      // Fetch one extra row as a "has more" sentinel; trim before
      // returning and reuse the trimmed row's keys for the next cursor.
      const rows = await db
        .select()
        .from(agentTransactions)
        .where(and(...where))
        .orderBy(desc(agentTransactions.blockTime), desc(agentTransactions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? encodeTxCursor(last.blockTime, last.id) : null;

      return c.json({ transactions: items, nextCursor });
    },
  );

  // 4.6 — Reasoning logs for an agent. Optional trace_id filter narrows
  // to a single trace; otherwise returns up to 100 spans (no cursor for
  // MVP, same rationale as alerts). Ordered by startTime ASC so the
  // dashboard's tree builder can walk parent→child in natural execution
  // order without a secondary in-memory re-sort.
  const reasoningQuerySchema = z.object({
    traceId: z
      .string()
      .regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  router.get(
    '/:id/reasoning',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    zValidator('query', reasoningQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');
      const { traceId, limit } = c.req.valid('query');

      const user = await ensureUser(db, privyDid);

      const [owned] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!owned) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      const where = [eq(reasoningLogs.agentId, agentId)];
      if (traceId) where.push(eq(reasoningLogs.traceId, traceId));

      const logs = await db
        .select()
        .from(reasoningLogs)
        .where(and(...where))
        .orderBy(asc(reasoningLogs.startTime))
        .limit(limit);

      return c.json({ reasoningLogs: logs });
    },
  );

  // 13.7 — Smoke-test the notification pipeline end-to-end. Builds an
  // ephemeral AlertMessage and pushes it through the same `deliver()`
  // router the detector uses. Does NOT write to the alerts table — we
  // don't want a "send test alert" click to pollute the user's feed.
  router.post(
    '/:id/test-alert',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);
      const [agent] = await db
        .select({
          id: agents.id,
          name: agents.name,
          telegramChatId: agents.telegramChatId,
          webhookUrl: agents.webhookUrl,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!agent) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      if (!alerter) {
        // 503 — server is up but the feature's dependency (Telegram
        // creds) is missing. HTTPException runs through the global
        // error handler so the body matches the canonical `{ error:
        // { code, message } }` envelope other routes use.
        throw new HTTPException(503, {
          message: 'alerter not configured on server',
        });
      }

      // Epic 14: pick the same channel the detector would use for this
      // agent so "test alert" proves the real delivery path, not a
      // hard-coded Telegram route. `webhook > telegram > 503`.
      // Telegram requires an explicit per-agent chat_id — no deployer-wide
      // fallback (multi-tenant safety).
      const webhookUrl = agent.webhookUrl ?? null;
      const telegramChatId = agent.telegramChatId ?? null;
      const channel: 'webhook' | 'telegram' | null = webhookUrl
        ? 'webhook'
        : alerter.telegram && telegramChatId
          ? 'telegram'
          : null;
      if (!channel) {
        throw new HTTPException(503, {
          message:
            'no delivery channel configured for this agent — set a telegram chat_id or webhook url',
        });
      }

      const perAgentDeps: DeliverDeps = {
        ...(alerter.telegram ? { telegram: alerter.telegram } : {}),
        ...(channel === 'webhook' && webhookUrl
          ? { webhook: createWebhookSender({ url: webhookUrl }) }
          : {}),
      };

      // 'test_alert' is intentionally not in the AlertRuleName union —
      // adding it there would ripple through persistence code for a
      // value that is never written to the `alerts` table. We build a
      // widened-ruleName local type (Omit + re-add as string) so the
      // pseudo-rule passes through without a blind enum cast; TypeScript
      // still checks every other AlertMessage field against its real type.
      type TestAlertMessage = Omit<AlertMessage, 'ruleName'> & { ruleName: string };
      const msg: TestAlertMessage = {
        id: randomUUID(),
        agentId: agent.id,
        agentName: agent.name,
        ruleName: 'test_alert',
        severity: 'info',
        payload: {
          isTest: true,
          source: 'dashboard smoke test',
        },
        triggeredAt: new Date().toISOString(),
        ...(agent.telegramChatId ? { chatId: agent.telegramChatId } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      };

      const result: DeliveryResult = await deliver(perAgentDeps, msg as AlertMessage, channel);
      if (!result.success) {
        // 502 — downstream channel rejected the send. The message is the
        // verbatim sender error so ops can act (invalid chat id, revoked
        // bot token, 4xx from webhook endpoint, etc.).
        throw new HTTPException(502, {
          message: result.error ?? 'delivery failed',
        });
      }
      return c.json({ ok: true, delivered: true, channel });
    },
  );

  // 3.9 — Delete. All children (agent_transactions, reasoning_logs,
  // alerts) are FK-cascaded at the schema level — no manual cleanup
  // needed. Ownership stays in the WHERE clause; a 404 response means
  // "not yours or not there", no existence oracle.
  router.delete(
    '/:id',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);

      const deleted = await db
        .delete(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .returning({ id: agents.id });

      if (deleted.length === 0) {
        throw new HTTPException(404, { message: 'agent not found' });
      }
      return c.body(null, 204);
    },
  );

  // 6.14 — SSE stream for real-time dashboard updates. Subscribes to the
  // in-process bus for this agent's events and pushes them as text/event-stream.
  // Ownership is verified before opening the stream.
  router.get(
    '/:id/stream',
    zValidator('param', agentIdParamSchema, (result) => {
      if (!result.success) {
        throw new HTTPException(422, { message: 'invalid agent id (expected uuid)' });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { id: agentId } = c.req.valid('param');

      const user = await ensureUser(db, privyDid);
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, user.id)))
        .limit(1);
      if (!agent) {
        throw new HTTPException(404, { message: 'agent not found' });
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (data: string) => {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            };

            // Send initial keepalive so the client knows the connection is alive.
            // Don't echo the agentId — the client already has it from the URL,
            // and including it risks information leakage if headers are logged.
            send(JSON.stringify({ type: 'connected' }));

            let unsub: () => void = () => {};
            try {
              unsub = sseBus.subscribe(agentId, (event) => {
                send(JSON.stringify(event));
              });
            } catch (err) {
              // Defensive: subscribe should not throw, but if it does we close
              // the stream cleanly rather than leaking a half-open response.
              try {
                controller.close();
              } catch {
                // already closed
              }
              throw err;
            }

            // Keepalive every 30s to prevent proxy/LB timeout
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
              }
            }, 30_000);

            // Cleanup when client disconnects — close the stream to free resources
            c.req.raw.signal.addEventListener('abort', () => {
              unsub();
              clearInterval(keepalive);
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            // Preserve the per-request Vary header set by the global no-store
            // middleware in app.ts: returning a `new Response` here bypasses
            // Hono's c.header() merge, so we must reapply it explicitly to
            // keep cache keys partitioned by Authorization on intermediaries
            // that ignore Cache-Control directives on text/event-stream.
            Vary: 'Authorization',
            Connection: 'keep-alive',
          },
        },
      );
    },
  );

  return router;
}
