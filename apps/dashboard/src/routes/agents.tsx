import { Sparkline } from '@/components/Sparkline';
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
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { useTimeseries } from '@/lib/use-timeseries';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Plus, Search } from 'lucide-react';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

const FRAMEWORKS = ['elizaos', 'agent-kit', 'custom'] as const;
const AGENT_TYPES = ['trader', 'yield', 'nft', 'other'] as const;

interface AgentRow {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: 'live' | 'stale' | 'failed';
  lastSeenAt: string | null;
  createdAt: string;
  recentTxCount24h: number;
  solDelta24h: string;
  successRate24h: number | null;
}

type Filter = 'all' | 'live' | 'stale' | 'failed';
const FILTERS: Filter[] = ['all', 'live', 'stale', 'failed'];

export function AgentsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });

  const agents = data?.agents ?? [];

  const counts = useMemo<Record<Filter, number>>(() => {
    return {
      all: agents.length,
      live: agents.filter((a) => a.status === 'live').length,
      stale: agents.filter((a) => a.status === 'stale').length,
      failed: agents.filter((a) => a.status === 'failed').length,
    };
  }, [agents]);

  const filtered = useMemo(() => {
    let list = filter === 'all' ? agents : agents.filter((a) => a.status === filter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || a.walletPubkey.toLowerCase().includes(q),
      );
    }
    return list;
  }, [agents, filter, search]);

  return (
    <div className="p-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-baseline gap-3 text-2xl font-semibold tracking-tight">
            Agents
            <span className="font-mono text-[13px] font-normal text-fg-3">({agents.length})</span>
          </h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Register, monitor & configure your on-chain AI agents.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnGhost} disabled title="Coming post-MVP">
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <AddAgentDialog />
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-4 border-b border-line">
        <div className="flex gap-0">
          {FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn(
                'relative px-4 py-2.5 font-mono text-xs lowercase tracking-wide transition-colors',
                filter === k ? 'text-fg' : 'text-fg-3 hover:text-fg-2',
              )}
            >
              {k}
              <span
                className={cn(
                  'ml-1.5 rounded-full border border-line px-1.5 py-px text-[10px]',
                  filter === k
                    ? 'border-[color:var(--accent-dim)] text-accent'
                    : 'bg-surface-2 text-fg-3',
                )}
              >
                {counts[k]}
              </span>
              {filter === k ? (
                <span
                  aria-hidden
                  className="absolute -bottom-px left-0 right-0 h-[1.5px] bg-accent"
                />
              ) : null}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 py-1.5">
          <label className="flex w-[260px] items-center gap-2 rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg-3">
            <Search className="h-3 w-3 shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or wallet…"
              className="flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3"
            />
          </label>
        </div>
      </div>

      {isLoading && <p className="font-mono text-xs text-fg-3">Loading agents…</p>}
      {error && (
        <p className="font-mono text-xs text-crit">Failed to load: {(error as Error).message}</p>
      )}

      {!isLoading && filtered.length === 0 ? (
        <div className="rounded-md border border-line bg-surface-2 px-8 py-16 text-center">
          <p className="text-[13px] text-fg-3">
            {search
              ? 'No agents match your search.'
              : filter === 'all'
                ? 'No agents registered yet.'
                : `No ${filter} agents.`}
          </p>
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-line bg-surface-2">
          <div className="grid min-w-[960px] grid-cols-[28px_minmax(180px,1.6fr)_minmax(140px,1.2fr)_80px_70px_70px_80px_90px_80px] gap-3 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            <span>#</span>
            <span>agent</span>
            <span>wallet</span>
            <span className="text-right">framework</span>
            <span className="text-right">tx · 24h</span>
            <span className="text-right">trend</span>
            <span className="text-right">sol · Δ</span>
            <span className="text-right">success</span>
            <span className="text-right">last seen</span>
          </div>
          {filtered.map((agent, i) => (
            <Link
              key={agent.id}
              to={`/agents/${agent.id}`}
              className="grid min-w-[960px] cursor-pointer grid-cols-[28px_minmax(180px,1.6fr)_minmax(140px,1.2fr)_80px_70px_70px_80px_90px_80px] items-center gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-3"
            >
              <span className="font-mono text-[10px] text-fg-3">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13.5px] font-medium text-fg">{agent.name}</span>
                <StatusBadge status={agent.status} />
              </div>
              <span className="truncate font-mono text-[11.5px] text-fg-3">
                {agent.walletPubkey}
              </span>
              <span className="text-right font-mono text-[11.5px] text-fg-2">
                {agent.framework}
              </span>
              <span className="text-right font-mono text-[11.5px] text-fg-2">
                {agent.recentTxCount24h}
              </span>
              <AgentTxSparkCell agentId={agent.id} />
              <SolDeltaCell value={agent.solDelta24h} />
              <SuccessRateCell rate={agent.successRate24h} />
              <span className="text-right font-mono text-[11px] text-fg-3">
                {agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : 'never'}
              </span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Per-agent 24h tx-count sparkline. Each cell opens its own
 * `/api/stats/timeseries?agentId=...` query — react-query dedupes and
 * caches, so re-renders are free. At MVP scale (a handful of agents per
 * user) the fan-out is fine; a batched endpoint is the natural upgrade
 * if this page ever has to render dozens of rows.
 */
function AgentTxSparkCell({ agentId }: { agentId: string }) {
  const { sparkPoints, isLoading } = useTimeseries({ agentId, metric: 'tx' });
  if (isLoading || sparkPoints.length < 2) {
    return <span className="text-right font-mono text-[11px] text-fg-3">—</span>;
  }
  return (
    <span className="flex items-center justify-end">
      <Sparkline points={sparkPoints} width={60} height={18} />
    </span>
  );
}

function SolDeltaCell({ value }: { value: string }) {
  const n = Number.parseFloat(value);
  const tone = n > 0 ? 'text-accent' : n < 0 ? 'text-crit' : 'text-fg-3';
  const sign = n > 0 ? '+' : '';
  return (
    <span className={cn('text-right font-mono text-[11.5px]', tone)}>
      {Number.isFinite(n) ? `${sign}${n.toFixed(3)}` : '—'}
    </span>
  );
}

function SuccessRateCell({ rate }: { rate: number | null }) {
  if (rate == null) {
    return <span className="text-right font-mono text-[11.5px] text-fg-3">—</span>;
  }
  const pct = Math.round(rate * 100);
  const tone = pct >= 95 ? 'text-accent' : pct >= 80 ? 'text-fg-2' : 'text-warn';
  return <span className={cn('text-right font-mono text-[11.5px]', tone)}>{pct}%</span>;
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

function AddAgentDialog() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: {
      name: string;
      walletPubkey: string;
      framework: string;
      agentType: string;
    }) => apiClient.post<{ agent: AgentRow }>('/api/agents', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setOpen(false);
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    mutation.mutate({
      name: (fd.get('name') as string).trim(),
      walletPubkey: (fd.get('walletPubkey') as string).trim(),
      framework: fd.get('framework') as string,
      agentType: fd.get('agentType') as string,
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={btnPrimary}>
          <Plus className="h-3.5 w-3.5" />
          <span>Register agent</span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Agent</DialogTitle>
          <DialogDescription>Add a new AI agent to monitor.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="agent-name"
              className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3"
            >
              Name
            </label>
            <Input
              id="agent-name"
              name="name"
              placeholder="My Trading Bot"
              required
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor="agent-wallet"
              className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3"
            >
              Wallet Public Key
            </label>
            <Input id="agent-wallet" name="walletPubkey" placeholder="So1ana…" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label
                htmlFor="agent-framework"
                className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3"
              >
                Framework
              </label>
              <select
                id="agent-framework"
                name="framework"
                required
                className="flex h-10 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
              >
                {FRAMEWORKS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label
                htmlFor="agent-type"
                className="font-mono text-[10.5px] uppercase tracking-wider text-fg-3"
              >
                Type
              </label>
              <select
                id="agent-type"
                name="agentType"
                required
                className="flex h-10 w-full rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
              >
                {AGENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {mutation.error ? (
            <p className="font-mono text-xs text-crit">{(mutation.error as Error).message}</p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const btnPrimary = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-accent px-2.5 font-mono text-[11.5px] font-medium tracking-tight',
  'text-[color:var(--primary-foreground)] hover:brightness-110 transition-[filter]',
);

const btnGhost = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-surface-2 px-2.5',
  'font-mono text-[11.5px] font-medium tracking-tight text-fg-2 hover:text-fg hover:border-fg-3 hover:bg-surface-3 transition-colors',
  'disabled:opacity-50 disabled:cursor-not-allowed',
);

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
