/**
 * Cross-agent reasoning routes (task 13.5).
 *
 * 13.5 — GET /api/reasoning/traces  → summarized traces across every agent
 *         the authenticated user owns.
 *
 * The per-agent variant (`GET /api/agents/:id/reasoning`) returns raw spans
 * ordered by startTime — good for a single trace's span tree. The Reasoning
 * Explorer page, by contrast, wants a cross-agent leaderboard of trace-level
 * summaries, so the aggregation needs to happen server-side instead of
 * fetching every span and collapsing in the browser.
 *
 * Shape matches the dashboard's `TraceSummary` interface so the page can
 * render the response 1:1 without a client-side adapter:
 *
 *   {
 *     traceId, rootSpanName, spanCount, startTime, durationMs, hasError, agentId
 *   }
 *
 * - ownership — INNER JOIN agents ON agents.user_id = $user (no existence oracle)
 * - agentId filter is optional; when present, further constrains on agent_id
 * - rootSpanName comes from the span with parent_span_id IS NULL; when a
 *   trace has no explicit root (malformed emission), we fall back to MAX(span_name)
 *   so the column is never null
 * - durationMs = max(end_time) - min(start_time), null-safe with COALESCE
 * - hasError flips true if any span in the trace has otel.status_code = 2 (ERROR)
 * - limit clamps at 100 to match alerts; default 50
 */

import { type Database, agents, reasoningLogs } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const DEFAULT_TRACES_LIMIT = 50;
const MAX_TRACES_LIMIT = 100;

const tracesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TRACES_LIMIT).default(DEFAULT_TRACES_LIMIT),
});

export function createReasoningRouter(db: Database) {
  const router = new Hono<ApiEnv>();

  router.get(
    '/traces',
    zValidator('query', tracesQuerySchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { agentId, limit } = c.req.valid('query');
      const user = await ensureUser(db, privyDid);

      const where = [eq(agents.userId, user.id)];
      if (agentId) where.push(eq(reasoningLogs.agentId, agentId));

      const rows = await db
        .select({
          traceId: reasoningLogs.traceId,
          spanCount: sql<number>`cast(count(*) as int)`,
          startTime: sql<string>`min(${reasoningLogs.startTime})`,
          endTime: sql<string | null>`max(${reasoningLogs.endTime})`,
          // Prefer the explicit root (parent_span_id IS NULL). Fall back to
          // any span name so the column is never null for malformed traces.
          rootSpanName: sql<string>`coalesce(
            max(${reasoningLogs.spanName}) filter (where ${reasoningLogs.parentSpanId} is null),
            max(${reasoningLogs.spanName})
          )`,
          hasError: sql<boolean>`coalesce(bool_or((${reasoningLogs.attributes}->>'otel.status_code')::int = 2), false)`,
          // A trace belongs to a single agent, so any value in the group is
          // the same. PG's MIN/MAX don't accept uuid directly, so we cast
          // through text; the uuid shape is preserved at the bytes level.
          agentId: sql<string>`(min(${reasoningLogs.agentId}::text))::uuid`,
        })
        .from(reasoningLogs)
        .innerJoin(agents, eq(reasoningLogs.agentId, agents.id))
        .where(and(...where))
        .groupBy(reasoningLogs.traceId)
        .orderBy(desc(sql`min(${reasoningLogs.startTime})`))
        .limit(limit);

      const traces = rows.map((r) => {
        const startMs = new Date(r.startTime).getTime();
        const endMs = r.endTime ? new Date(r.endTime).getTime() : Number.NaN;
        const durationMs =
          Number.isFinite(startMs) && Number.isFinite(endMs)
            ? Math.max(0, Math.round(endMs - startMs))
            : null;
        return {
          traceId: r.traceId,
          rootSpanName: r.rootSpanName,
          spanCount: r.spanCount,
          startTime: r.startTime,
          durationMs,
          hasError: r.hasError,
          agentId: r.agentId,
        };
      });

      return c.json({ traces });
    },
  );

  return router;
}
