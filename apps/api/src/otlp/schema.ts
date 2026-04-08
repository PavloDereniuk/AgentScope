/**
 * OTLP/HTTP JSON request schema (task 4.2).
 *
 * Zod schemas that validate incoming `ExportTraceServiceRequest`
 * payloads as defined by the OpenTelemetry protocol. We ship our own
 * schema instead of depending on `@opentelemetry/otlp-transformer`
 * because that package's public surface only covers the exporter side
 * (SDK → collector). The request types we need (`IExportTraceServiceRequest`,
 * `IResourceSpans`, etc.) exist only in its internal build output
 * (`build/esm/trace/internal-types.d.ts`) and are not re-exported —
 * depending on them would be a deep import into private API.
 *
 * OTLP/HTTP JSON is a stable wire protocol (OTLP spec §JSON Protobuf
 * Encoding), so encoding our own schema is safe. Per spec:
 *
 * - `traceId` is a 32-char lowercase hex string (16 bytes)
 * - `spanId` / `parentSpanId` are 16-char lowercase hex strings (8 bytes)
 * - `startTimeUnixNano` / `endTimeUnixNano` / `Event.timeUnixNano`
 *   are `fixed64` nanoseconds. JSON encodes int64 as a string to avoid
 *   JS number precision loss; we also accept plain numbers for
 *   convenience up to Number.MAX_SAFE_INTEGER.
 * - `intValue` inside `AnyValue` is int64 → same rule as above.
 * - All `repeated` proto3 fields are optional (empty allowed) in JSON.
 *
 * Types are inferred with `z.infer` so this module is the single
 * source of truth for both runtime validation and static types.
 */

import { z } from 'zod';

/** 16-byte trace id → 32 lowercase hex chars. */
const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters (16 bytes)');

/** 8-byte span id → 16 lowercase hex chars. */
const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, 'spanId must be 16 lowercase hex characters (8 bytes)');

/**
 * uint64 over JSON. Primary encoding is a numeric string (per the
 * OTLP JSON encoding rules); we also accept a JS number as long as
 * it's a non-negative safe integer.
 */
const uint64Schema = z.union([
  z.string().regex(/^\d+$/, 'must be a non-negative integer string'),
  z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .transform((n) => n.toString()),
]);

/**
 * `AnyValue` is the recursive variant type used by OTLP attributes.
 * Exactly one field should be set in spec, but receivers traditionally
 * tolerate looser inputs — we validate structure only and let callers
 * pick whichever field is present.
 *
 * The `| undefined` on every optional field is required because zod
 * infers `string | undefined` for `z.string().optional()` while
 * `exactOptionalPropertyTypes` treats `field?: string` as "absent OR
 * string, never undefined". Keeping the type declaration aligned with
 * zod's inference makes `z.ZodType<AnyValueInput>` assignable below.
 */
export type AnyValueInput = {
  stringValue?: string | undefined;
  boolValue?: boolean | undefined;
  intValue?: string | number | undefined;
  doubleValue?: number | undefined;
  bytesValue?: string | undefined;
  arrayValue?: { values?: AnyValueInput[] | undefined } | undefined;
  kvlistValue?: { values?: Array<{ key: string; value: AnyValueInput }> | undefined } | undefined;
};

const anyValueSchema: z.ZodType<AnyValueInput> = z.lazy(() =>
  z
    .object({
      stringValue: z.string().optional(),
      boolValue: z.boolean().optional(),
      intValue: z.union([z.string().regex(/^-?\d+$/), z.number().int()]).optional(),
      doubleValue: z.number().optional(),
      // `bytesValue` is base64-encoded per OTLP JSON spec. We don't
      // decode it here — callers that care must do that themselves.
      bytesValue: z.string().optional(),
      arrayValue: z
        .object({
          values: z.array(anyValueSchema).optional(),
        })
        .optional(),
      kvlistValue: z
        .object({
          values: z.array(keyValueSchema).optional(),
        })
        .optional(),
    })
    .strict(),
);

const keyValueSchema: z.ZodType<{ key: string; value: AnyValueInput }> = z.lazy(() =>
  z
    .object({
      key: z.string(),
      value: anyValueSchema,
    })
    .strict(),
);

const instrumentationScopeSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    attributes: z.array(keyValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const resourceSchema = z
  .object({
    attributes: z.array(keyValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const statusSchema = z
  .object({
    message: z.string().optional(),
    // 0 = UNSET, 1 = OK, 2 = ERROR
    code: z.number().int().min(0).max(2).optional(),
  })
  .strict();

const eventSchema = z
  .object({
    timeUnixNano: uint64Schema,
    name: z.string(),
    attributes: z.array(keyValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const linkSchema = z
  .object({
    traceId: traceIdSchema,
    spanId: spanIdSchema,
    traceState: z.string().optional(),
    attributes: z.array(keyValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
    flags: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * SpanKind enum values per OTLP proto:
 *   0 UNSPECIFIED, 1 INTERNAL, 2 SERVER, 3 CLIENT, 4 PRODUCER, 5 CONSUMER
 */
const spanKindSchema = z.number().int().min(0).max(5);

const spanSchema = z
  .object({
    traceId: traceIdSchema,
    spanId: spanIdSchema,
    traceState: z.string().optional(),
    parentSpanId: spanIdSchema.optional(),
    flags: z.number().int().nonnegative().optional(),
    name: z.string().min(1),
    kind: spanKindSchema.optional(),
    startTimeUnixNano: uint64Schema,
    endTimeUnixNano: uint64Schema,
    attributes: z.array(keyValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
    events: z.array(eventSchema).optional(),
    droppedEventsCount: z.number().int().nonnegative().optional(),
    links: z.array(linkSchema).optional(),
    droppedLinksCount: z.number().int().nonnegative().optional(),
    status: statusSchema.optional(),
  })
  .strict();

const scopeSpansSchema = z
  .object({
    scope: instrumentationScopeSchema.optional(),
    spans: z.array(spanSchema).optional(),
    schemaUrl: z.string().optional(),
  })
  .strict();

const resourceSpansSchema = z
  .object({
    resource: resourceSchema.optional(),
    scopeSpans: z.array(scopeSpansSchema).optional(),
    schemaUrl: z.string().optional(),
  })
  .strict();

/**
 * Top-level body of `POST /v1/traces`. All fields are optional per
 * proto3 semantics; an empty object `{}` is a valid (no-op) request.
 */
export const exportTraceServiceRequestSchema = z
  .object({
    resourceSpans: z.array(resourceSpansSchema).optional(),
  })
  .strict();

export type ExportTraceServiceRequest = z.infer<typeof exportTraceServiceRequestSchema>;
export type ResourceSpans = z.infer<typeof resourceSpansSchema>;
export type ScopeSpans = z.infer<typeof scopeSpansSchema>;
export type Span = z.infer<typeof spanSchema>;
export type KeyValue = z.infer<typeof keyValueSchema>;
export type AnyValue = z.infer<typeof anyValueSchema>;
export type SpanEvent = z.infer<typeof eventSchema>;
export type SpanLink = z.infer<typeof linkSchema>;
export type SpanStatus = z.infer<typeof statusSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type InstrumentationScope = z.infer<typeof instrumentationScopeSchema>;
