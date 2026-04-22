import { apiClient } from '@/lib/api-client';
import type { TraceSummary } from '@/lib/trace-summaries';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

interface AgentRow {
  id: string;
  name: string;
  status: 'live' | 'stale' | 'failed';
}

const ALL_AGENTS = '__all__';

/**
 * Global reasoning explorer. Backed by the cross-agent `/api/reasoning/traces`
 * endpoint added in task 13.5 — the agent dropdown is now an optional filter
 * that defaults to "all agents", matching the Claude Design prototype.
 *
 * `summarizeTraces` from `lib/trace-summaries.ts` is still used on the
 * per-agent-detail page to collapse raw spans; we no longer need it here
 * because the server already returns summarised rows.
 */
export function ReasoningPage() {
  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });

  const agents = agentsQuery.data?.agents ?? [];
  const [agentFilter, setAgentFilter] = useState<string>(ALL_AGENTS);
  const [traceFilter, setTraceFilter] = useState('');

  const tracesQuery = useQuery({
    queryKey: ['reasoning', 'traces', agentFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (agentFilter !== ALL_AGENTS) params.set('agentId', agentFilter);
      const qs = params.toString();
      return apiClient.get<{ traces: TraceSummary[] }>(
        `/api/reasoning/traces${qs ? `?${qs}` : ''}`,
      );
    },
  });

  const traces = tracesQuery.data?.traces ?? [];

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  // Trace ID is free-form substring match now (client-side). No 32-hex regex
  // gate — if the user types a prefix, they probably want to find a trace
  // that starts with those characters.
  const trimmed = traceFilter.trim().toLowerCase();
  const visibleTraces = useMemo(
    () => (trimmed ? traces.filter((t) => t.traceId.includes(trimmed)) : traces),
    [traces, trimmed],
  );

  return (
    <div className="p-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reasoning Explorer</h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Trace spans emitted via OTLP across every agent you own — filter by agent or trace ID.
          </p>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-[320px_1fr] gap-3 max-[760px]:grid-cols-1">
        <Field label="Agent">
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="w-full cursor-pointer bg-transparent font-mono text-[12.5px] text-fg outline-none"
          >
            <option value={ALL_AGENTS}>all agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.status}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Trace ID filter">
          <input
            value={traceFilter}
            onChange={(e) => setTraceFilter(e.target.value)}
            placeholder="type a prefix to filter…"
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
            {tracesQuery.isFetching ? 'loading…' : `${visibleTraces.length} shown`}
          </span>
        </div>
        {tracesQuery.isLoading ? (
          <EmptyMessage text="Loading traces…" />
        ) : tracesQuery.error ? (
          <EmptyMessage text={`Failed to load: ${(tracesQuery.error as Error).message}`} />
        ) : visibleTraces.length === 0 ? (
          <EmptyMessage
            text={
              traces.length === 0
                ? 'No spans recorded yet. Send OTLP traces via agent.token to populate.'
                : 'No traces match the current filter.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Agent</Th>
                  <Th>Trace ID</Th>
                  <Th>Root Span</Th>
                  <Th className="text-right">Spans</Th>
                  <Th className="text-right">Duration</Th>
                  <Th className="text-right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {visibleTraces.map((trace) => (
                  <tr
                    key={trace.traceId}
                    className="cursor-pointer border-b border-line-soft transition-colors last:border-b-0 hover:bg-surface-3"
                  >
                    <Td className="font-mono text-fg-3">
                      {new Date(trace.startTime).toLocaleTimeString()}
                    </Td>
                    <Td className="font-mono text-fg-2">
                      {agentNameById.get(trace.agentId) ?? trace.agentId.slice(0, 8)}
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
