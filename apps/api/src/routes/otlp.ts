/**
 * OTLP/HTTP JSON receiver (task 4.2).
 *
 * Exposes `POST /v1/traces` — the canonical OTLP/HTTP endpoint that
 * OpenTelemetry SDK exporters hit by default when
 * `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`. The router is
 * mounted at `/v1` in `buildApp`, so the effective path lines up
 * with what every upstream SDK expects without any custom exporter
 * configuration on the agent side.
 *
 * Scope of this task: validate the incoming JSON body against our
 * zod schema, count the inbound spans, log a structured summary,
 * and return the OTLP success envelope. Auth (4.3), persistence
 * (4.4) and tx correlation (4.5) are deliberately out of scope.
 *
 * Response shape: we return `{ partialSuccess: {} }` which tells
 * the exporter that every span was accepted (empty partial success).
 * This matches the `ExportTraceServiceResponse` message in the OTLP
 * proto and keeps OpenTelemetry clients happy across languages.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from '../logger';
import { type ExportTraceServiceRequest, exportTraceServiceRequestSchema } from '../otlp/schema';

interface OtlpRouterDeps {
  logger: Logger;
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

export function createOtlpRouter({ logger }: OtlpRouterDeps) {
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
    (c) => {
      const body = c.req.valid('json');
      const counts = countSpans(body);
      logger.info(
        {
          resourceSpansCount: counts.resourceSpans,
          scopeSpansCount: counts.scopeSpans,
          spanCount: counts.spans,
        },
        'otlp traces received',
      );
      // Empty partial success = accepted all spans.
      return c.json({ partialSuccess: {} }, 200);
    },
  );

  return router;
}
