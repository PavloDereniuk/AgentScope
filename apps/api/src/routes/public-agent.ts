/**
 * Public read-only demo agent endpoints (C.0b).
 *
 * All routes are unauthenticated. Only the agent whose UUID matches
 * `PUBLIC_DEMO_AGENT_ID` (config) is served; any other UUID returns 404
 * with no existence oracle for the rest of the registry.
 *
 * Sensitive fields are stripped from every response via an explicit
 * Zod pick — type-safe guarantee that ingestToken / telegramChatId /
 * webhookUrl / alertRules.pausedUntil never cross the wire.
 *
 * Mounted at /public alongside the badge router.
 *
 * GET /public/demo                    → {agentId} | 404
 * GET /public/agents/:id/overview     → agent overview + KPIs
 * GET /public/agents/:id/transactions → paginated tx list
 * GET /public/agents/:id/alerts       → recent alerts
 */

import { type Database, agentTransactions, agents, alerts, reasoningLogs } from '@agentscope/db';
import { and, asc, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { decodeTxCursor, encodeTxCursor } from '../lib/cursor';
import type { RateLimiter } from '../middleware/rate-limit';

const agentIdParamSchema = z.object({ id: z.string().uuid() });

const txListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Only the fields safe to expose publicly. */
const PUBLIC_AGENT_COLUMNS = {
  id: agents.id,
  walletPubkey: agents.walletPubkey,
  name: agents.name,
  framework: agents.framework,
  agentType: agents.agentType,
  status: agents.status,
  tags: agents.tags,
  createdAt: agents.createdAt,
  lastSeenAt: agents.lastSeenAt,
} as const;

const RECENT_TX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ALERTS = 20;

function getClientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const cf = req.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  return null;
}

// Sets Retry-After before throwing so clients back off correctly.
// Note: c.header() must be called before HTTPException — the global error
// handler (error.ts) rebuilds the response but preserves headers already set
// on the context (same pattern as ingest.ts:211 and otlp.ts:121).
function applyRateLimit(limiter: RateLimiter | undefined, c: Context): void {
  if (!limiter) return;
  const ip = getClientIp(c.req.raw);
  if (!ip) return;
  const decision = limiter.take(ip);
  if (!decision.ok) {
    c.header('Retry-After', String(decision.retryAfterSec));
    throw new HTTPException(429, { message: 'rate limit exceeded' });
  }
}

export interface PublicAgentRouterDeps {
  db: Database;
  /** UUID of the single agent exposed publicly. Unset → all routes return 404. */
  demoAgentId?: string;
  /** Per-IP rate limiter. Unset → unlimited (tests). */
  ipLimiter?: RateLimiter;
}

export function createPublicAgentRouter(deps: PublicAgentRouterDeps) {
  const { db, demoAgentId, ipLimiter } = deps;
  const router = new Hono();

  // Returns the configured demo agent's UUID so the dashboard /share route
  // can resolve the target ID without knowing it at build time.
  router.get('/demo', (c) => {
    if (!demoAgentId) {
      throw new HTTPException(404, { message: 'demo not configured' });
    }
    return c.json({ agentId: demoAgentId });
  });

  // Validates the :id param and enforces the demo-only gate.
  // Returns the agent row on success; throws 404 (no oracle) on any mismatch.
  async function getDemoAgent(id: string) {
    if (!demoAgentId || id !== demoAgentId) {
      throw new HTTPException(404, { message: 'not found' });
    }
    const [row] = await db
      .select(PUBLIC_AGENT_COLUMNS)
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    if (!row) {
      throw new HTTPException(404, { message: 'not found' });
    }
    return row;
  }

  router.get('/agents/:id/overview', async (c) => {
    applyRateLimit(ipLimiter, c);

    const parsed = agentIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }
    const { id } = parsed.data;
    const agent = await getDemoAgent(id);

    const since = new Date(Date.now() - RECENT_TX_WINDOW_MS).toISOString();
    const [txCountRow] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, id), gte(agentTransactions.blockTime, since)));
    const recentTxCount = txCountRow?.count ?? 0;

    const [lastAlert] = await db
      .select()
      .from(alerts)
      .where(eq(alerts.agentId, id))
      .orderBy(desc(alerts.triggeredAt))
      .limit(1);

    const [solDeltaRow] = await db
      .select({
        solDelta24h: sql<string>`coalesce(sum(${agentTransactions.solDelta}), 0)::text`,
        successCount: sql<number>`cast(count(*) filter (where ${agentTransactions.success}) as int)`,
      })
      .from(agentTransactions)
      .where(and(eq(agentTransactions.agentId, id), gte(agentTransactions.blockTime, since)));

    const txCount = recentTxCount;
    const successCount = solDeltaRow?.successCount ?? 0;

    return c.json({
      agent,
      recentTxCount,
      solDelta24h: solDeltaRow?.solDelta24h ?? '0',
      successRate24h: txCount > 0 ? successCount / txCount : null,
      lastAlert: lastAlert ?? null,
    });
  });

  router.get('/agents/:id/transactions', async (c) => {
    applyRateLimit(ipLimiter, c);

    const parsed = agentIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }
    const { id } = parsed.data;
    await getDemoAgent(id);

    const queryParsed = txListQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!queryParsed.success) {
      throw new HTTPException(422, { message: 'invalid query params' });
    }
    const { cursor, limit } = queryParsed.data;

    const where = [eq(agentTransactions.agentId, id)];
    if (cursor) {
      const decoded = decodeTxCursor(cursor);
      if (!decoded) {
        throw new HTTPException(422, { message: 'invalid cursor' });
      }
      where.push(
        or(
          lt(agentTransactions.blockTime, decoded.t),
          and(eq(agentTransactions.blockTime, decoded.t), lt(agentTransactions.id, decoded.i)),
        ) as ReturnType<typeof lt>,
      );
    }

    const rows = await db
      .select({
        id: agentTransactions.id,
        signature: agentTransactions.signature,
        blockTime: agentTransactions.blockTime,
        programId: agentTransactions.programId,
        instructionName: agentTransactions.instructionName,
        solDelta: agentTransactions.solDelta,
        success: agentTransactions.success,
        feeLamports: agentTransactions.feeLamports,
      })
      .from(agentTransactions)
      .where(and(...where))
      .orderBy(desc(agentTransactions.blockTime), desc(agentTransactions.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeTxCursor(last.blockTime, last.id) : null;

    return c.json({ transactions: items, nextCursor });
  });

  router.get('/agents/:id/transactions/:signature/spans', async (c) => {
    applyRateLimit(ipLimiter, c);

    const parsed = agentIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }
    const { id } = parsed.data;
    await getDemoAgent(id);

    const sigParsed = z.string().min(1).max(128).safeParse(c.req.param('signature'));
    if (!sigParsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }

    const rows = await db
      .select({
        spanId: reasoningLogs.spanId,
        parentSpanId: reasoningLogs.parentSpanId,
        spanName: reasoningLogs.spanName,
        startTime: reasoningLogs.startTime,
        endTime: reasoningLogs.endTime,
        attributes: reasoningLogs.attributes,
        traceId: reasoningLogs.traceId,
      })
      .from(reasoningLogs)
      .where(and(eq(reasoningLogs.agentId, id), eq(reasoningLogs.txSignature, sigParsed.data)))
      .orderBy(asc(reasoningLogs.startTime))
      .limit(50);

    return c.json({ spans: rows });
  });

  router.get('/agents/:id/alerts', async (c) => {
    applyRateLimit(ipLimiter, c);

    const parsed = agentIdParamSchema.safeParse(c.req.param());
    if (!parsed.success) {
      throw new HTTPException(404, { message: 'not found' });
    }
    const { id } = parsed.data;
    await getDemoAgent(id);

    const rows = await db
      .select({
        id: alerts.id,
        agentId: alerts.agentId,
        severity: alerts.severity,
        ruleName: alerts.ruleName,
        payload: alerts.payload,
        triggeredAt: alerts.triggeredAt,
        deliveryStatus: alerts.deliveryStatus,
      })
      .from(alerts)
      .where(eq(alerts.agentId, id))
      .orderBy(desc(alerts.triggeredAt))
      .limit(MAX_ALERTS);

    return c.json({ alerts: rows });
  });

  return router;
}
