/**
 * OTLP span persistence (task 4.4).
 *
 * Converts validated OTLP Spans into `reasoning_logs` rows and batch
 * inserts them.  The unique index on `(trace_id, span_id)` makes the
 * operation idempotent — duplicate spans (e.g. from OTel SDK retries)
 * are silently skipped via `ON CONFLICT DO NOTHING`.
 *
 * OTel metadata that has no dedicated column (`kind`, `status.code`,
 * `status.message`) is stored inside the `attributes` jsonb under
 * reserved `otel.*` keys so the detector (Epic 5) can query them.
 *
 * Tx correlation (4.5): if a span carries a `solana.tx.signature`
 * attribute, its value is extracted into `reasoning_logs.tx_signature`
 * so the REST API can join reasoning logs with on-chain transactions.
 */

import { type Database, reasoningLogs } from '@agentscope/db';
import type { AnyValueInput, ExportTraceServiceRequest, KeyValue } from './schema';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Recursively convert an OTLP `AnyValue` variant into a plain JS value
 * suitable for JSON storage.
 */
export function flattenAnyValue(av: AnyValueInput): unknown {
  if (av.stringValue !== undefined) return av.stringValue;
  if (av.boolValue !== undefined) return av.boolValue;
  if (av.intValue !== undefined) return av.intValue;
  if (av.doubleValue !== undefined) return av.doubleValue;
  if (av.bytesValue !== undefined) return av.bytesValue;
  if (av.arrayValue?.values) return av.arrayValue.values.map(flattenAnyValue);
  if (av.kvlistValue?.values) {
    const obj: Record<string, unknown> = {};
    for (const kv of av.kvlistValue.values) {
      obj[kv.key] = flattenAnyValue(kv.value);
    }
    return obj;
  }
  return null;
}

/** Flatten an OTLP `KeyValue[]` array into a plain `Record<string, unknown>`. */
export function flattenAttributes(kvs: KeyValue[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const kv of kvs) {
    result[kv.key] = flattenAnyValue(kv.value);
  }
  return result;
}

/**
 * Convert a nanosecond Unix timestamp (string) to an ISO-8601 string.
 * Divides by 1 000 000 to get milliseconds, then uses `Date`. Sub-ms
 * precision is lost — acceptable for MVP.
 */
export function nanoToTimestamp(nanos: string): string {
  let big: bigint;
  try {
    big = BigInt(nanos);
  } catch {
    throw new Error(`invalid nanosecond timestamp: ${nanos}`);
  }
  const ms = big / 1_000_000n;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`nanosecond timestamp too large to convert safely: ${nanos}`);
  }
  return new Date(Number(ms)).toISOString();
}

/** Span attribute key for on-chain transaction correlation (4.5). */
export const TX_SIGNATURE_KEY = 'solana.tx.signature';

// ── persist ──────────────────────────────────────────────────────────────────

export interface PersistSpansOptions {
  db: Database;
  body: ExportTraceServiceRequest;
  agentId: string;
}

/**
 * Walk the OTLP envelope and insert every span into `reasoning_logs`.
 * Returns the number of rows actually inserted (excludes duplicates).
 */
export async function persistSpans({ db, body, agentId }: PersistSpansOptions): Promise<number> {
  const rows: Array<typeof reasoningLogs.$inferInsert> = [];

  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = flattenAttributes(span.attributes ?? []);

        if (span.kind !== undefined) attrs['otel.kind'] = span.kind;
        if (span.status?.code !== undefined) attrs['otel.status_code'] = span.status.code;
        if (span.status?.message !== undefined) attrs['otel.status_message'] = span.status.message;

        const txSig = typeof attrs[TX_SIGNATURE_KEY] === 'string' ? attrs[TX_SIGNATURE_KEY] : null;

        rows.push({
          agentId,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? null,
          spanName: span.name,
          startTime: nanoToTimestamp(span.startTimeUnixNano),
          endTime: nanoToTimestamp(span.endTimeUnixNano),
          attributes: attrs,
          txSignature: txSig,
        });
      }
    }
  }

  if (rows.length === 0) return 0;

  // Chunk inserts to avoid hitting Postgres's 65535 bind-parameter limit.
  // At ~9 columns per row this caps out at ~7 282 rows; 500 rows/chunk is safe.
  const CHUNK_SIZE = 500;
  let insertedCount = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const result = await db
      .insert(reasoningLogs)
      .values(chunk)
      .onConflictDoNothing({ target: [reasoningLogs.traceId, reasoningLogs.spanId] })
      .returning({ id: reasoningLogs.id });
    insertedCount += result.length;
  }

  return insertedCount;
}
