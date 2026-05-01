/**
 * Pure utility shared by every reasoning UI surface (Reasoning Explorer
 * row expand, TxDrawer span list, agent-detail recent panel).
 *
 * `buildTree` collapses a flat list of spans into a parent → children
 * forest using `parentSpanId` as the edge. It is robust against two
 * shapes that real OTel traffic produces and that crashed earlier
 * versions of the renderer:
 *
 *   1. Self-referential edges (parentSpanId === spanId) — bogus but
 *      observed in the wild from buggy SDK wrappers.
 *   2. Transitive cycles (A → B → C → A) — almost always a bug, but
 *      the dashboard must keep rendering when one shows up. Spans
 *      inside a detected cycle are promoted to roots so the tree
 *      stays finite.
 *
 * Spans whose parent is missing from the input (out-of-window root
 * trim, or a partial trace) also become roots — better to show the
 * subtree than to drop it.
 */

export interface TraceSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, unknown>;
  txSignature: string | null;
}

export interface TraceTreeNode<S extends TraceSpan = TraceSpan> {
  span: S;
  children: TraceTreeNode<S>[];
}

export function buildTraceTree<S extends TraceSpan>(spans: S[]): TraceTreeNode<S>[] {
  const byId = new Map<string, TraceTreeNode<S>>();
  const parentOf = new Map<string, string>();
  for (const span of spans) {
    byId.set(span.spanId, { span, children: [] });
    if (span.parentSpanId && span.parentSpanId !== span.spanId) {
      parentOf.set(span.spanId, span.parentSpanId);
    }
  }

  // Detect transitive cycles (A → B → C → A) by walking each span's
  // parent chain. Any span that reaches itself is in a cycle; we promote
  // it to a root so the tree stays finite.
  const inCycle = new Set<string>();
  for (const span of spans) {
    const seen = new Set<string>([span.spanId]);
    let current = parentOf.get(span.spanId);
    while (current) {
      if (seen.has(current)) {
        inCycle.add(span.spanId);
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }

  const roots: TraceTreeNode<S>[] = [];
  const childSet = new Set<string>();
  for (const span of spans) {
    const node = byId.get(span.spanId);
    if (!node) continue;
    const parentId = parentOf.get(span.spanId);
    const parent = parentId && !inCycle.has(span.spanId) ? byId.get(parentId) : undefined;
    if (parent && !childSet.has(span.spanId)) {
      childSet.add(span.spanId);
      parent.children.push(node);
    } else if (!parent) {
      roots.push(node);
    }
  }
  return roots;
}

/** Hard depth cap so a degenerate tree never blows the renderer. */
export const MAX_TREE_DEPTH = 50;

export function spanDurationMs(span: Pick<TraceSpan, 'startTime' | 'endTime'>): number {
  const ms = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/**
 * The L0 ingest contract reserves three keys on the attributes jsonb to
 * mirror OTLP's SpanKind / status fields without a schema migration.
 * Surfacing them as first-class chips in the UI requires the same key
 * names everywhere.
 */
export const RESERVED_OTEL_KEYS = ['otel.kind', 'otel.status_code', 'otel.status_message'] as const;

const SPAN_KIND_LABELS: Record<number, string> = {
  0: 'unspecified',
  1: 'internal',
  2: 'server',
  3: 'client',
  4: 'producer',
  5: 'consumer',
};

export function spanKindLabel(kind: unknown): string | null {
  if (typeof kind !== 'number') return null;
  return SPAN_KIND_LABELS[kind] ?? `kind=${kind}`;
}

const STATUS_CODE_LABELS: Record<number, 'unset' | 'ok' | 'error'> = {
  0: 'unset',
  1: 'ok',
  2: 'error',
};

export function statusCodeLabel(code: unknown): 'unset' | 'ok' | 'error' | null {
  if (typeof code !== 'number') return null;
  return STATUS_CODE_LABELS[code] ?? null;
}

/**
 * Split attributes into the OTel-reserved triple (rendered as chips)
 * and the user-defined remainder (rendered as JSON). Useful for any
 * UI that wants to surface kind/status without burying them in raw
 * JSON.
 */
export function partitionAttributes(attrs: Record<string, unknown>): {
  kind: string | null;
  status: 'unset' | 'ok' | 'error' | null;
  statusMessage: string | null;
  user: Record<string, unknown>;
} {
  const user: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!RESERVED_OTEL_KEYS.includes(k as (typeof RESERVED_OTEL_KEYS)[number])) {
      user[k] = v;
    }
  }
  const statusMessage = attrs['otel.status_message'];
  return {
    kind: spanKindLabel(attrs['otel.kind']),
    status: statusCodeLabel(attrs['otel.status_code']),
    statusMessage: typeof statusMessage === 'string' ? statusMessage : null,
    user,
  };
}
