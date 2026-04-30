/**
 * Universal flat-JSON span ingest (Epic 15 — L0 REST).
 *
 * Exposes `POST /v1/spans` — a one-span-per-request endpoint that any
 * language (curl, Python `requests`, a Bash one-liner) can hit without
 * pulling in an OpenTelemetry SDK. The OTLP/HTTP receiver
 * (`POST /v1/traces`) remains the canonical path for SDK-instrumented
 * agents; this endpoint is the lowest-friction integration tier
 * documented in QUICKSTART as "L0 — Universal REST".
 *
 * Why a separate route?
 *   - OTLP/HTTP requires a deeply nested envelope
 *     (`resourceSpans → scopeSpans → spans`) and `agent.token` lives on
 *     a resource attribute, not the standard Authorization header. That
 *     shape exists because OTel SDKs batch many spans into one export;
 *     it is hostile to hand-written REST clients.
 *   - This route accepts a single span at a flat top-level, takes the
 *     token from `Authorization: Bearer ...` (universally idiomatic),
 *     and accepts both ISO 8601 timestamps and Unix epoch milliseconds
 *     so callers do not need to compute nanoseconds themselves.
 *
 * Storage path: every accepted span flows through the *same*
 * `reasoning_logs` row layout as OTLP. The dashboard's Reasoning
 * Explorer therefore renders L0 spans identically to L2/SDK spans —
 * no per-source code paths downstream.
 *
 * Idempotency: the unique `(trace_id, span_id)` index on
 * `reasoning_logs` makes retries safe — a duplicate POST silently
 * returns 200 with `{ inserted: 0 }`.
 *
 * Auth + budget reuse:
 *   - `Authorization: Bearer <ingest_token>` is resolved through the
 *     same `agents.ingest_token` lookup as OTLP (4.3).
 *   - The optional rate limiter is keyed by the bearer token. `app.ts`
 *     wires the *same* limiter instance as `/v1/traces`, so the
 *     100/min/agent.token budget (14.13) is shared across both ingest
 *     surfaces — an agent cannot bypass quota by mixing the two.
 */

import { type Database, reasoningLogs } from '@agentscope/db';
import { SOLANA_SIGNATURE_RE } from '@agentscope/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Logger } from '../logger';
import type { RateLimiter } from '../middleware/rate-limit';
import { resolveAgentByToken } from '../otlp/auth';

interface IngestRouterDeps {
  db: Database;
  logger: Logger;
  /**
   * Optional rate limiter keyed by the bearer token. Defaults to no
   * limit so tests opt in explicitly. Production wires the same
   * 100/min limiter that `/v1/traces` uses, sharing budget per token.
   * Applied after auth so an invalid token surfaces as 401, not 429.
   */
  rateLimit?: RateLimiter;
}

// Hex helpers mirror the OTLP schema so both routes accept exactly the
// same identifier shapes — keeps client code portable between L0 and L2.
const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters (16 bytes)');
const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'spanId must be 16 lowercase hex characters (8 bytes)');

/**
 * Accept either an ISO 8601 datetime string OR a Unix epoch in
 * milliseconds (number). Anything else fails validation up front so
 * we never persist garbage timestamps. Conversion to the canonical
 * ISO string happens in the handler.
 */
const timestampSchema = z.union([
  z.string().datetime({ offset: true }),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);

const ingestSpanSchema = z
  .object({
    traceId: traceIdSchema,
    spanId: spanIdSchema,
    parentSpanId: spanIdSchema.optional(),
    name: z.string().min(1),
    startTime: timestampSchema,
    endTime: timestampSchema,
    // Free-form key/value bag. Unknown nested shapes are preserved as-is
    // — the dashboard renders them via JSON.stringify, so callers can
    // attach whatever structured context their agent emits.
    attributes: z.record(z.string(), z.unknown()).optional(),
    /**
     * Optional Solana signature for tx ↔ span correlation. Validated
     * up front because the value lands in an indexed column and a
     * malformed string would corrupt the join Reasoning Explorer
     * relies on.
     */
    txSignature: z
      .string()
      .regex(SOLANA_SIGNATURE_RE, 'txSignature must be a valid Solana signature')
      .optional(),
    /** OTel SpanKind: 0 UNSPECIFIED, 1 INTERNAL, 2 SERVER, 3 CLIENT, 4 PRODUCER, 5 CONSUMER. */
    kind: z.number().int().min(0).max(5).optional(),
    status: z
      .object({
        code: z.number().int().min(0).max(2),
        message: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type IngestSpanInput = z.infer<typeof ingestSpanSchema>;

function toIsoTimestamp(input: string | number): string {
  // Numbers are Unix epoch milliseconds; strings are already ISO 8601
  // (the schema's `.datetime()` enforced that). `new Date(string)`
  // round-trips ISO without precision loss for ms-grained inputs.
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  return d.toISOString();
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  // Tolerate any single-space variant of "Bearer". RFC 6750 specifies
  // case-insensitive scheme, exactly one whitespace separator.
  const match = header.match(/^Bearer\s+(\S.*)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

export function createIngestRouter({ db, logger, rateLimit }: IngestRouterDeps) {
  const router = new Hono();

  router.post(
    '/spans',
    zValidator('json', ingestSpanSchema, (result) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HTTPException(422, { message });
      }
    }),
    async (c) => {
      const token = extractBearerToken(c.req.header('Authorization'));
      if (!token) {
        throw new HTTPException(401, {
          message: 'missing Authorization: Bearer <ingest_token> header',
        });
      }

      const resolved = await resolveAgentByToken(db, token);
      if (!resolved) {
        throw new HTTPException(401, { message: 'invalid agent token' });
      }

      // Rate-limit AFTER auth so probes with bogus tokens cannot poison
      // a real agent's budget (or signal "this token exists" via 429).
      // Shares the limiter instance with `/v1/traces` in production so
      // the per-token quota is enforced across both ingest surfaces.
      //
      // Headers go on `c` directly because the global error handler
      // rebuilds the response from `HTTPException.message` and ignores
      // `err.res` — see `middleware/error.ts`. Setting them here lets
      // the 429 still ship a proper `Retry-After` to the caller.
      if (rateLimit) {
        const decision = rateLimit.take(token);
        if (!decision.ok) {
          logger.warn(
            { agentId: resolved.agentId, retryAfterSec: decision.retryAfterSec },
            'ingest spans rate-limited',
          );
          c.header('Retry-After', String(decision.retryAfterSec));
          c.header('X-RateLimit-Remaining', '0');
          throw new HTTPException(429, { message: 'rate limit exceeded' });
        }
      }

      const body = c.req.valid('json');

      // Mirror the OTLP persist path: reserve `otel.*` keys inside the
      // attributes jsonb so the detector and Reasoning Explorer can
      // query span kind / status without a schema migration. Callers
      // who set their own `otel.kind` attribute lose to the explicit
      // `kind` field — same precedence as `persistSpans`.
      const attrs: Record<string, unknown> = { ...(body.attributes ?? {}) };
      if (body.kind !== undefined) attrs['otel.kind'] = body.kind;
      if (body.status?.code !== undefined) attrs['otel.status_code'] = body.status.code;
      if (body.status?.message !== undefined) attrs['otel.status_message'] = body.status.message;

      let startTime: string;
      let endTime: string;
      try {
        startTime = toIsoTimestamp(body.startTime);
        endTime = toIsoTimestamp(body.endTime);
      } catch {
        throw new HTTPException(422, { message: 'invalid startTime or endTime' });
      }

      const result = await db
        .insert(reasoningLogs)
        .values({
          agentId: resolved.agentId,
          traceId: body.traceId,
          spanId: body.spanId,
          parentSpanId: body.parentSpanId ?? null,
          spanName: body.name,
          startTime,
          endTime,
          attributes: attrs,
          txSignature: body.txSignature ?? null,
        })
        .onConflictDoNothing({ target: [reasoningLogs.traceId, reasoningLogs.spanId] })
        .returning({ id: reasoningLogs.id });

      const inserted = result.length;

      logger.info(
        {
          agentId: resolved.agentId,
          userId: resolved.userId,
          traceId: body.traceId,
          spanId: body.spanId,
          inserted,
        },
        'ingest span received',
      );

      return c.json({ inserted }, 200);
    },
  );

  return router;
}
