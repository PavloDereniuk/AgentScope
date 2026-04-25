import { IntegrationSnippet } from '@/components/IntegrationSnippet';
import { Kpi, KpiRow } from '@/components/Kpi';
import { TxDrawer } from '@/components/TxDrawer';
import { PnlChart } from '@/components/pnl-chart';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { getPublicApiUrl } from '@/lib/api-url';
import { useStream } from '@/lib/use-stream';
import { cn } from '@/lib/utils';
import { formatAlertSummary, formatRuleTitle } from '@agentscope/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

interface AgentDetail {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: 'live' | 'stale' | 'failed';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  ingestToken?: string;
}

interface AlertRow {
  id: string;
  severity: string;
  ruleName: string;
  payload: Record<string, unknown>;
  triggeredAt: string;
}

interface AgentDetailResponse {
  agent: AgentDetail;
  recentTxCount: number;
  lastAlert: AlertRow | null;
}

interface TxRow {
  id: number;
  signature: string;
  blockTime: string;
  programId: string;
  instructionName: string | null;
  solDelta: string;
  success: boolean;
  feeLamports: number;
}

interface TxListResponse {
  transactions: TxRow[];
  nextCursor: string | null;
}

interface ReasoningLogRow {
  id: string;
  spanId: string;
  spanName: string;
  startTime: string;
  endTime: string | null;
  parentSpanId: string | null;
}

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selectedTx, setSelectedTx] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [walletCopyState, setWalletCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    if (walletCopyState === 'idle') return;
    const t = window.setTimeout(() => setWalletCopyState('idle'), 1500);
    return () => window.clearTimeout(t);
  }, [walletCopyState]);

  useStream(id);

  const deleteMutation = useMutation({
    mutationFn: () => apiClient.delete(`/api/agents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', id] });
      navigate('/agents');
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => apiClient.get<AgentDetailResponse>(`/api/agents/${id}`),
    enabled: Boolean(id),
  });

  const { data: txData } = useQuery({
    queryKey: ['agent-tx', id],
    queryFn: () => apiClient.get<TxListResponse>(`/api/agents/${id}/transactions?limit=50`),
    enabled: Boolean(id),
  });

  // Recent spans preview — detailed view lives under /reasoning.
  const { data: reasoningData } = useQuery({
    queryKey: ['reasoning-preview', id],
    queryFn: () =>
      apiClient.get<{ reasoningLogs: ReasoningLogRow[] }>(`/api/agents/${id}/reasoning`),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <div className="p-7">
        <p className="font-mono text-xs text-fg-3">Loading agent…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4 p-7">
        <p className="font-mono text-xs text-crit">
          {error ? (error as Error).message : 'Agent not found'}
        </p>
        <Button asChild variant="ghost">
          <Link to="/agents">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to agents
          </Link>
        </Button>
      </div>
    );
  }

  const { agent, recentTxCount, lastAlert } = data;
  const transactions = txData?.transactions ?? [];

  const successes = transactions.filter((t) => t.success).length;
  const successRate = transactions.length > 0 ? (successes / transactions.length) * 100 : 0;
  const totalSolDelta = transactions.reduce((sum, tx) => {
    const delta = Number(tx.solDelta);
    return Number.isFinite(delta) ? sum + delta : sum;
  }, 0);

  return (
    <div className="p-7">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/agents"
            className="mb-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-fg-3 hover:text-fg"
          >
            <ArrowLeft className="h-3 w-3" />
            agents
          </Link>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
            <StatusBadge status={agent.status} />
            <TagBadge>{agent.framework}</TagBadge>
            <TagBadge>{agent.agentType}</TagBadge>
          </div>
          <p className="mt-1.5 truncate font-mono text-[12px] text-fg-3">{agent.walletPubkey}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(agent.walletPubkey);
                setWalletCopyState('copied');
              } catch {
                setWalletCopyState('error');
              }
            }}
            className={btnGhost}
          >
            <Copy className="h-3.5 w-3.5" />
            {walletCopyState === 'copied'
              ? 'Copied'
              : walletCopyState === 'error'
                ? 'Copy failed'
                : 'Copy wallet'}
          </button>
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger asChild>
              <button type="button" className={btnDanger}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete agent</DialogTitle>
                <DialogDescription>
                  This will permanently delete <strong>{agent.name}</strong> and all its
                  transactions, alerts, and reasoning logs. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              {deleteMutation.isError ? (
                <p className="font-mono text-xs text-crit">
                  {(deleteMutation.error as Error).message || 'Failed to delete agent'}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    deleteMutation.reset();
                    setDeleteOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                >
                  {deleteMutation.isPending
                    ? 'Deleting…'
                    : deleteMutation.isError
                      ? 'Retry delete'
                      : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="mb-5">
        <IntegrationSnippet
          apiUrl={getPublicApiUrl()}
          agentToken={agent.ingestToken}
          hasTraffic={recentTxCount > 0}
        />
      </div>

      <KpiRow>
        <Kpi label="Tx · 24h" value={recentTxCount.toLocaleString()} />
        <Kpi
          label="Success Rate"
          value={`${successRate.toFixed(1)}%`}
          delta={`${successes}/${transactions.length} loaded`}
          deltaKind="dim"
        />
        <Kpi
          label="SOL Delta"
          value={`${totalSolDelta >= 0 ? '+' : ''}${totalSolDelta.toFixed(2)}`}
          delta="across loaded window"
          deltaKind={totalSolDelta >= 0 ? 'pos' : 'neg'}
        />
        {lastAlert ? (
          <Kpi
            variant="sm"
            label="Last Alert"
            value={formatRuleTitle(lastAlert.ruleName)}
            delta={formatAlertSummary(lastAlert.ruleName, lastAlert.payload)}
            deltaKind="neg"
          />
        ) : (
          <Kpi variant="sm" label="Last Alert" value="none" delta="all clear" deltaKind="dim" />
        )}
      </KpiRow>

      <div className="mb-5 grid grid-cols-[1.6fr_1fr] gap-4 max-[1100px]:grid-cols-1">
        <Card title="PnL · Cumulative SOL" meta={`${transactions.length} tx · live`}>
          <div className="px-4 pb-4 pt-2">
            <PnlChart transactions={transactions} />
          </div>
        </Card>
        <Card title="Reasoning · recent" meta={`${reasoningData?.reasoningLogs.length ?? 0} spans`}>
          <div className="px-4 pb-4 pt-2 font-mono text-[12px]">
            {reasoningData?.reasoningLogs.length ? (
              <ul className="flex flex-col gap-1.5">
                {reasoningData.reasoningLogs.slice(0, 3).map((span) => (
                  <li key={span.id} className="flex items-center gap-2">
                    <span className="truncate text-fg">{span.spanName}</span>
                    <span className="ml-auto text-[10.5px] tabular-nums text-fg-3">
                      {formatSpanDuration(span.startTime, span.endTime)}
                    </span>
                  </li>
                ))}
                <li className="pt-2">
                  <Link
                    to="/reasoning"
                    className="font-mono text-[11px] text-accent hover:underline"
                  >
                    → view all traces
                  </Link>
                </li>
              </ul>
            ) : (
              <p className="text-fg-3">No spans recorded yet.</p>
            )}
          </div>
        </Card>
      </div>

      <Card title="Transactions · loaded window" meta="click row to open">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-[13px]">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Signature</Th>
                <Th>Instruction</Th>
                <Th className="text-right">SOL Δ</Th>
                <Th className="text-right">Fee</Th>
                <Th className="text-right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => {
                // Guard against null/undefined/non-numeric solDelta — NaN breaks
                // both the conditional colour class (NaN >= 0 is false) and the
                // rendered value. Same pattern as pnl-chart / tx-timeline / TxDrawer.
                const rawDelta = Number(tx.solDelta);
                const delta = Number.isFinite(rawDelta) ? rawDelta : 0;
                return (
                  <tr
                    key={tx.id}
                    tabIndex={0}
                    aria-label={`View transaction ${shortenSignature(tx.signature)}`}
                    onClick={() => setSelectedTx(tx.signature)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedTx(tx.signature);
                      }
                    }}
                    className="cursor-pointer border-b border-line-soft transition-colors last:border-b-0 hover:bg-surface-3 focus:outline-none focus:bg-surface-3"
                  >
                    <Td className="font-mono text-fg-3">
                      {new Date(tx.blockTime).toLocaleTimeString()}
                    </Td>
                    <Td className="font-mono text-fg">{shortenSignature(tx.signature)}</Td>
                    <Td className="font-mono text-fg-2">{tx.instructionName ?? '—'}</Td>
                    <Td
                      className={cn(
                        'text-right font-mono tabular-nums',
                        delta >= 0 ? 'text-accent' : 'text-crit',
                      )}
                    >
                      {delta >= 0 ? '+' : ''}
                      {delta.toFixed(4)}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-fg-3">
                      {tx.feeLamports.toLocaleString()}
                    </Td>
                    <Td className="text-right">
                      <StatusPill ok={tx.success} />
                    </Td>
                  </tr>
                );
              })}
              {transactions.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-10 text-center font-mono text-[12px] text-fg-3"
                  >
                    No transactions yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <TxDrawer signature={selectedTx} onClose={() => setSelectedTx(null)} />
    </div>
  );
}

function Card({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">{title}</span>
        {meta ? (
          <span className="font-mono text-[10.5px] tracking-[0.04em] text-fg-3">{meta}</span>
        ) : null}
      </div>
      {children}
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

function StatusBadge({ status }: { status: 'live' | 'stale' | 'failed' }) {
  const styles =
    status === 'live'
      ? 'text-accent border-[color:var(--accent-dim)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
      : status === 'stale'
        ? 'text-warn border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))]'
        : 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]';
  const dot =
    status === 'live'
      ? 'bg-accent shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent)_25%,transparent)]'
      : status === 'stale'
        ? 'bg-warn'
        : 'bg-crit';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        styles,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {status}
    </span>
  );
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        ok
          ? 'text-accent border-[color:var(--accent-dim)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
          : 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-accent' : 'bg-crit')} />
      {ok ? 'ok' : 'fail'}
    </span>
  );
}

function TagBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
      {children}
    </span>
  );
}

function formatSpanDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return `${Math.max(0, ms)}ms`;
}

function shortenSignature(sig: string): string {
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}

const btnGhost = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-surface-2 px-2.5',
  'font-mono text-[11.5px] font-medium tracking-tight text-fg-2 hover:text-fg hover:border-fg-3 hover:bg-surface-3 transition-colors',
);

const btnDanger = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] border px-2.5',
  'font-mono text-[11.5px] font-medium tracking-tight text-crit transition-colors',
  'border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))] bg-surface-2',
  'hover:bg-[color:color-mix(in_oklch,var(--crit)_12%,var(--bg-2))]',
);
