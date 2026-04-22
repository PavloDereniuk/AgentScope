import { apiClient } from '@/lib/api-client';
import { type TraceSummary, summarizeTraces } from '@/lib/trace-summaries';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

interface AgentRow {
  id: string;
  name: string;
  status: 'live' | 'stale' | 'failed';
}

interface ReasoningLogRow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  agentId: string;
  spanName: string;
  startTime: string;
  endTime: string | null;
  attributes: Record<string, unknown> | null;
  txSignature: string | null;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Global reasoning explorer. The backend exposes reasoning logs only
 * per-agent (`/api/agents/:id/reasoning`), so this page scopes the
 * trace list to the selected agent. Switching agents reuses the same
 * query surface — post-MVP we'll add a cross-agent `/api/reasoning`
 * endpoint so the dropdown becomes "all agents" by default.
 */
export function ReasoningPage() {
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });

  const agents = agentsQuery.data?.agents ?? [];
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [traceFilter, setTraceFilter] = useState('');

  const activeAgentId = selectedAgent || agents[0]?.id || '';
  const trimmedFilter = traceFilter.trim().toLowerCase();
  const isValidTraceFilter = trimmedFilter === '' || TRACE_ID_PATTERN.test(trimmedFilter);

  const reasoningQuery = useQuery({
    queryKey: [
      'reasoning',
      activeAgentId,
      isValidTraceFilter && trimmedFilter ? trimmedFilter : null,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (isValidTraceFilter && trimmedFilter) params.set('traceId', trimmedFilter);
      const qs = params.toString();
      return apiClient.get<{ reasoningLogs: ReasoningLogRow[] }>(
        `/api/agents/${activeAgentId}/reasoning${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: Boolean(activeAgentId) && isValidTraceFilter,
  });

  const traces = useMemo<TraceSummary[]>(() => {
    const logs = reasoningQuery.data?.reasoningLogs ?? [];
    return summarizeTraces(logs);
  }, [reasoningQuery.data]);

  return (
    <div className="p-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reasoning Explorer</h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Trace spans emitted via OTLP. Parent-child nesting, resource attrs, tx correlation.
          </p>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-[320px_1fr] gap-3 max-[760px]:grid-cols-1">
        <Field label="Agent">
          <select
            value={activeAgentId}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="w-full cursor-pointer bg-transparent font-mono text-[12.5px] text-fg outline-none"
          >
            {agents.length === 0 ? <option value="">no agents</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.status}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Trace ID filter"
          {...(!isValidTraceFilter ? { hint: 'expects 32 lowercase hex chars' } : {})}
        >
          <input
            value={traceFilter}
            onChange={(e) => setTraceFilter(e.target.value)}
            placeholder="e.g. 83e2b4a1c0d5f6e7b8a9c0d1e2f3a4b5"
            className="w-full bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-3"
          />
        </Field>
      </div>

      <div className="overflow-hidden rounded-md border border-line bg-surface-2">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">
            Traces
          </span>
          <span className="font-mono text-[10.5px] text-fg-3">
            {reasoningQuery.isFetching ? 'loading…' : `${traces.length} shown`}
          </span>
        </div>
        {!activeAgentId ? (
          <EmptyMessage text="Register an agent to see reasoning traces." />
        ) : reasoningQuery.isLoading ? (
          <EmptyMessage text="Loading traces…" />
        ) : traces.length === 0 ? (
          <EmptyMessage text="No spans recorded yet. Send OTLP traces via agent.token to populate." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Trace ID</Th>
                  <Th>Root Span</Th>
                  <Th className="text-right">Spans</Th>
                  <Th className="text-right">Duration</Th>
                  <Th className="text-right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace) => (
                  <tr
                    key={trace.traceId}
                    className="cursor-pointer border-b border-line-soft transition-colors last:border-b-0 hover:bg-surface-3"
                  >
                    <Td className="font-mono text-fg-3">
                      {new Date(trace.startTime).toLocaleTimeString()}
                    </Td>
                    <Td className="font-mono text-fg">
                      <Link to={`/agents/${trace.agentId}?traceId=${trace.traceId}`}>
                        {trace.traceId.slice(0, 10)}…
                      </Link>
                    </Td>
                    <Td className="font-mono text-fg-2">{trace.rootSpanName}</Td>
                    <Td className="text-right font-mono tabular-nums text-fg-2">
                      {trace.spanCount}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-fg-3">
                      {trace.durationMs !== null ? `${trace.durationMs.toLocaleString()}ms` : '—'}
                    </Td>
                    <Td className="text-right">
                      <TraceStatusBadge error={trace.hasError} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
        <span>{label}</span>
        {hint ? (
          <span className="normal-case tracking-normal text-[11px] text-crit">{hint}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2 rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5">
        {children}
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-line px-4 py-2.5 text-left font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-fg-3',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('px-4 py-3 align-middle text-fg-2', className)}>{children}</td>;
}

function TraceStatusBadge({ error }: { error: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        error
          ? 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]'
          : 'text-accent border-[color:var(--accent-dim)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', error ? 'bg-crit' : 'bg-accent')} />
      {error ? 'error' : 'ok'}
    </span>
  );
}

function EmptyMessage({ text }: { text: string }) {
  return <div className="px-6 py-12 text-center font-mono text-[12px] text-fg-3">{text}</div>;
}
