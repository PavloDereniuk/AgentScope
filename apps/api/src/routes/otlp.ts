/**
 * OTLP/HTTP JSON receiver (tasks 4.2 + 4.3).
 *
 * Exposes `POST /v1/traces` — the canonical OTLP/HTTP endpoint that
 * OpenTelemetry SDK exporters hit by default when
 * `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`. The router is
 * mounted at `/v1` in `buildApp`, so the effective path lines up
 * with what every upstream SDK expects without any custom exporter
 * configuration on the agent side.
 *
 * Auth (4.3): agents stamp their per-agent ingest token onto the
 * `agent.token` resource attribute of their tracer provider. The
 * receiver extracts it from the first ResourceSpans, looks it up
 * against `agents.ingest_token`, and rejects with 401 if the
 * attribute is missing or the token is unknown. See `../otlp/auth.ts`
 * for the extractor + resolver and the rationale for using a
 * resource attribute over an HTTP header.
 *
 * Flow: validate body → authenticate agent → persist spans (4.4) →
 * log a structured summary → return OTLP success envelope. Tx
 * correlation (4.5) is out of scope for now.
 *
 * Response shape: `{ partialSuccess: {} }` tells the exporter that
 * every span was accepted (empty partial success). This matches
 * `ExportTraceServiceResponse` in the OTLP proto and keeps
 * OpenTelemetry clients happy across languages.
 */

import type { Database } from '@agentscope/db';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from '../logger';
import { extractAgentToken, resolveAgentByToken } from '../otlp/auth';
import { persistSpans } from '../otlp/persist';
import { type ExportTraceServiceRequest, exportTraceServiceRequestSchema } from '../otlp/schema';

interface OtlpRouterDeps {
  logger: Logger;
  db: Database;
}

/**
 * Walk the OTLP envelope and return (resourceSpansCount, scopeSpansCount, spanCount).
 * Exported so tests can assert counts without re-implementing the traversal.
 */
export function countSpans(body: ExportTraceServiceRequest): {
  resourceSpans: number;
  scopeSpans: number;
  spans: number;
} {
  const resourceSpans = body.resourceSpans ?? [];
  let scopeSpans = 0;
  let spans = 0;
  for (const rs of resourceSpans) {
    const scopes = rs.scopeSpans ?? [];
    scopeSpans += scopes.length;
    for (const ss of scopes) {
      spans += ss.spans?.length ?? 0;
    }
  }
  return { resourceSpans: resourceSpans.length, scopeSpans, spans };
}

export function createOtlpRouter({ logger, db }: OtlpRouterDeps) {
  const router = new Hono();

  router.post(
    '/traces',
    zValidator('json', exportTraceServiceRequestSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const body = c.req.valid('json');

      // Auth: agent.token lives on the first ResourceSpans' resource.
      // Both "missing" and "unknown" collapse to a single 401 so an
      // attacker cannot distinguish "no such agent" from "no token".
      const token = extractAgentToken(body);
      if (!token) {
        throw new HTTPException(401, {
          message: `missing or empty ${'agent.token'} resource attribute`,
        });
      }

      const resolved = await resolveAgentByToken(db, token);
      if (!resolved) {
        throw new HTTPException(401, { message: 'invalid agent token' });
      }

      const counts = countSpans(body);
      const persisted = await persistSpans({ db, body, agentId: resolved.agentId });

      logger.info(
        {
          agentId: resolved.agentId,
          userId: resolved.userId,
          resourceSpansCount: counts.resourceSpans,
          scopeSpansCount: counts.scopeSpans,
          spanCount: counts.spans,
          persisted,
        },
        'otlp traces received',
      );
      // Empty partial success = accepted all spans.
      return c.json({ partialSuccess: {} }, 200);
    },
  );

  return router;
}
