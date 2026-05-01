/**
 * Renders a single trace as an expandable span tree with full
 * attributes, kind/status chips, and tx_signature deep-links.
 *
 * Two ways to feed it:
 *   1. Pass `traceId` — fetches `/api/reasoning/traces/:traceId` itself.
 *      Used by the Reasoning Explorer row-expand.
 *   2. Pass `spans` — render an existing span list (no fetch). Used by
 *      TxDrawer where we already have spans correlated to a tx
 *      signature, and don't want a second round-trip.
 *
 * Why one component for both: every reasoning surface in the dashboard
 * needs the same affordances — collapsible parent/child structure,
 * attributes JSON, OTel kind/status, Solscan link for txSignature.
 * Splitting the rendering across three pages led to the gap where
 * /reasoning showed nothing past `name + duration`.
 */

import { apiClient } from '@/lib/api-client';
import {
  MAX_TREE_DEPTH,
  type TraceSpan,
  type TraceTreeNode,
  buildTraceTree,
  partitionAttributes,
  spanDurationMs,
} from '@/lib/build-trace-tree';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch } from 'lucide-react';
import { useState } from 'react';

interface TraceDetailSpan extends TraceSpan {
  agentId?: string;
  agentName?: string;
  agentWalletPubkey?: string;
}

interface TraceDetailResponse {
  traceId: string;
  spans: TraceDetailSpan[];
  truncated: boolean;
}

type Props =
  | { traceId: string; spans?: never; emptyHint?: string }
  | { spans: TraceDetailSpan[]; traceId?: never; emptyHint?: string; truncated?: boolean };

export function TraceDetailPanel(props: Props) {
  const isFetched = 'traceId' in props && props.traceId !== undefined;

  const query = useQuery({
    queryKey: ['reasoning-trace-detail', isFetched ? props.traceId : null],
    queryFn: () => apiClient.get<TraceDetailResponse>(`/api/reasoning/traces/${props.traceId}`),
    enabled: isFetched,
  });

  const spans: TraceDetailSpan[] = isFetched ? (query.data?.spans ?? []) : props.spans;
  const truncated = isFetched ? (query.data?.truncated ?? false) : (props.truncated ?? false);
  const tree = buildTraceTree(spans);

  if (isFetched && query.isLoading) {
    return <div className="px-4 py-3 font-mono text-[11px] text-fg-3">Loading spans…</div>;
  }

  if (isFetched && query.error) {
    return (
      <div className="px-4 py-3 font-mono text-[11px] text-crit">
        Failed to load trace: {(query.error as Error).message}
      </div>
    );
  }

  if (spans.length === 0) {
    return (
      <div className="px-4 py-3 font-mono text-[11px] text-fg-3">
        {props.emptyHint ?? 'No spans for this trace.'}
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {tree.map((root) => (
        <SpanNode key={root.span.spanId} node={root} depth={0} />
      ))}
      {truncated ? (
        <p className="px-1 pt-2 font-mono text-[10.5px] text-fg-3">
          Trace truncated — showing the earliest spans only.
        </p>
      ) : null}
    </div>
  );
}

function SpanNode({ node, depth }: { node: TraceTreeNode<TraceDetailSpan>; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const [showDetails, setShowDetails] = useState(false);
  const { span, children } = node;
  if (depth > MAX_TREE_DEPTH) return null;

  const duration = spanDurationMs(span);
  const { kind, status, statusMessage, user } = partitionAttributes(span.attributes);
  const userAttrEntries = Object.entries(user);
  const hasDetails =
    userAttrEntries.length > 0 ||
    span.txSignature !== null ||
    statusMessage !== null ||
    kind !== null ||
    status !== null;

  return (
    <div>
      <div
        className="group flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[12px] hover:bg-surface-3"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-label={
            children.length > 0
              ? `${expanded ? 'Collapse' : 'Expand'} children of ${span.spanName}`
              : `Span ${span.spanName}`
          }
          aria-expanded={children.length > 0 ? expanded : undefined}
          disabled={children.length === 0}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-3 disabled:opacity-30"
        >
          {children.length > 0 ? (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </button>
        <GitBranch className="h-3 w-3 shrink-0 text-fg-3" />
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          aria-label={`${showDetails ? 'Hide' : 'Show'} details for ${span.spanName}`}
          disabled={!hasDetails}
          className="font-mono text-[12px] text-fg hover:underline disabled:cursor-default disabled:no-underline disabled:hover:no-underline"
        >
          {span.spanName}
        </button>
        {kind ? <Chip label={kind} tone="dim" /> : null}
        {status ? <Chip label={status} tone={status === 'error' ? 'crit' : 'pos'} /> : null}
        {span.txSignature ? <TxLink signature={span.txSignature} /> : null}
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-fg-3">
          {duration}ms
        </span>
      </div>

      {showDetails && hasDetails ? (
        <div
          className="mb-1 ml-1 mt-0.5 rounded border border-line-soft bg-surface px-3 py-2 font-mono text-[11px]"
          style={{ marginLeft: `${depth * 16 + 24}px` }}
        >
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-fg-2">
            {span.agentName ? (
              <Row label="agent">
                <span>{span.agentName}</span>
              </Row>
            ) : null}
            <Row label="span_id">
              <span className="text-fg-3">{span.spanId}</span>
            </Row>
            {span.parentSpanId ? (
              <Row label="parent">
                <span className="text-fg-3">{span.parentSpanId}</span>
              </Row>
            ) : null}
            {kind ? (
              <Row label="kind">
                <span>{kind}</span>
              </Row>
            ) : null}
            {status ? (
              <Row label="status">
                <span className={cn(status === 'error' ? 'text-crit' : 'text-fg-2')}>
                  {status}
                  {statusMessage ? ` — ${statusMessage}` : ''}
                </span>
              </Row>
            ) : null}
            {span.txSignature ? (
              <Row label="tx_signature">
                <span className="break-all text-fg-3">{span.txSignature}</span>
              </Row>
            ) : null}
            <Row label="started">
              <span className="text-fg-3">{span.startTime}</span>
            </Row>
            <Row label="ended">
              <span className="text-fg-3">{span.endTime}</span>
            </Row>
          </dl>

          {userAttrEntries.length > 0 ? (
            <div className="mt-2">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
                attributes
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-2 px-2 py-1.5 text-[11px] leading-relaxed text-fg-2">
                {JSON.stringify(user, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {expanded &&
        children.map((child) => (
          <SpanNode key={child.span.spanId} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-[0.08em] text-fg-3">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Chip({ label, tone }: { label: string; tone: 'dim' | 'pos' | 'crit' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.08em]',
        tone === 'dim' && 'border-line text-fg-3',
        tone === 'pos' &&
          'border-[color:var(--accent-dim)] text-accent bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]',
        tone === 'crit' &&
          'border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))] text-crit',
      )}
    >
      {label}
    </span>
  );
}

function TxLink({ signature }: { signature: string }) {
  return (
    <a
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-line px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-3 hover:text-fg"
      title={signature}
    >
      tx
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}
