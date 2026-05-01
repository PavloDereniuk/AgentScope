/**
 * Cross-agent reasoning routes (task 13.5).
 *
 * 13.5 — GET /api/reasoning/traces           → summarized traces across every
 *         agent the authenticated user owns (one row per traceId).
 * 15.x — GET /api/reasoning/traces/:traceId  → all raw spans for one trace,
 *         enriched with the owning agent's name. Powers the expand-row UI on
 *         the Reasoning Explorer page so callers do not need to know the
 *         agentId up front (the trace summaries do not surface it as a
 *         filter, only as a label).
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
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { ensureUser } from '../lib/users';
import type { ApiEnv } from '../middleware/auth';

const DEFAULT_TRACES_LIMIT = 50;
const MAX_TRACES_LIMIT = 100;
// Hard cap on raw spans returned for a single trace. Agents can in
// principle emit hundreds of spans per trace (deeply nested tool calls
// + retries) — the dashboard tree handles ~50 comfortably, beyond that
// it stops being useful as a UI element. Truncation is signaled to the
// client so it can render a "trace truncated" hint instead of silently
// hiding spans.
const MAX_SPANS_PER_TRACE = 500;

const tracesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TRACES_LIMIT).default(DEFAULT_TRACES_LIMIT),
});

const traceIdParamSchema = z.object({
  // Match the OTLP / L0 ingest contract — 32 lowercase hex chars (16 bytes).
  // Validated up front so a malformed param can't reach the WHERE clause.
  traceId: z.string().regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters'),
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
          // Compare as text rather than casting to int — a malformed
          // attribute (e.g. stringified object) on a single span would
          // otherwise raise `invalid input syntax` and fail the whole
          // aggregate. OTLP spans always persist `otel.status_code` as a
          // number, which JSON->text renders as '0' / '1' / '2'.
          hasError: sql<boolean>`coalesce(bool_or((${reasoningLogs.attributes}->>'otel.status_code') = '2'), false)`,
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

  // GET /api/reasoning/traces/:traceId — raw spans for one trace.
  //
  // Ownership: INNER JOIN agents WHERE agents.user_id = $user. A traceId
  // owned by another user returns 404 so we don't leak existence.
  // Same shape on "trace not found" and "trace owned by someone else".
  //
  // Response includes the owning agent's name + walletPubkey alongside
  // each span so the client can render "Agent X · span_name" labels
  // without a second round-trip. (A trace belongs to one agent, so the
  // labels repeat — repetition is cheaper than another endpoint.)
  router.get(
    '/traces/:traceId',
    zValidator('param', traceIdParamSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const privyDid = c.get('userId');
      const { traceId } = c.req.valid('param');
      const user = await ensureUser(db, privyDid);

      const rows = await db
        .select({
          id: reasoningLogs.id,
          traceId: reasoningLogs.traceId,
          spanId: reasoningLogs.spanId,
          parentSpanId: reasoningLogs.parentSpanId,
          spanName: reasoningLogs.spanName,
          startTime: reasoningLogs.startTime,
          endTime: reasoningLogs.endTime,
          attributes: reasoningLogs.attributes,
          txSignature: reasoningLogs.txSignature,
          agentId: reasoningLogs.agentId,
          agentName: agents.name,
          agentWalletPubkey: agents.walletPubkey,
        })
        .from(reasoningLogs)
        .innerJoin(agents, eq(reasoningLogs.agentId, agents.id))
        .where(and(eq(reasoningLogs.traceId, traceId), eq(agents.userId, user.id)))
        // Fetch one extra row to detect truncation (length > MAX is the
        // signal). The client never sees that extra row in the response.
        .orderBy(asc(reasoningLogs.startTime))
        .limit(MAX_SPANS_PER_TRACE + 1);

      if (rows.length === 0) {
        throw new HTTPException(404, { message: 'trace not found' });
      }

      const truncated = rows.length > MAX_SPANS_PER_TRACE;
      const spans = truncated ? rows.slice(0, MAX_SPANS_PER_TRACE) : rows;

      return c.json({ traceId, spans, truncated });
    },
  );

  return router;
}
