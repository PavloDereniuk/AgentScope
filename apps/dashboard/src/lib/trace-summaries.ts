export interface ReasoningLogLike {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  agentId: string;
  spanName: string;
  startTime: string;
  endTime: string | null;
  attributes: Record<string, unknown> | null;
}

export interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  spanCount: number;
  startTime: string;
  durationMs: number | null;
  hasError: boolean;
  agentId: string;
}

/**
 * Collapse a flat span list into per-trace summaries suitable for the
 * Reasoning Explorer table. Kept as a pure function so the reasoning
 * route stays render-only and the logic can be unit-tested without a DOM.
 */
export function summarizeTraces(logs: ReasoningLogLike[]): TraceSummary[] {
  const byTrace = new Map<string, { spans: ReasoningLogLike[]; agentId: string }>();
  for (const log of logs) {
    const entry = byTrace.get(log.traceId);
    if (entry) entry.spans.push(log);
    else byTrace.set(log.traceId, { spans: [log], agentId: log.agentId });
  }

  const summaries: TraceSummary[] = [];
  for (const [traceId, { spans, agentId }] of byTrace.entries()) {
    const root = spans.find((s) => s.parentSpanId === null) ?? spans[0];
    if (!root) continue;

    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const span of spans) {
      const spanStart = new Date(span.startTime).getTime();
      if (Number.isFinite(spanStart) && spanStart < start) start = spanStart;
      if (span.endTime) {
        const spanEnd = new Date(span.endTime).getTime();
        if (Number.isFinite(spanEnd) && spanEnd > end) end = spanEnd;
      }
    }
    const durationMs =
      end > 0 && start !== Number.POSITIVE_INFINITY ? Math.max(0, Math.round(end - start)) : null;

    const hasError = spans.some((s) => {
      const status = s.attributes?.['otel.status_code'];
      return status === 2 || status === 'ERROR';
    });

    summaries.push({
      traceId,
      rootSpanName: root.spanName,
      spanCount: spans.length,
      startTime: root.startTime,
      durationMs,
      hasError,
      agentId,
    });
  }

  summaries.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return summaries;
}
