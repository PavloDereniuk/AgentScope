import { Kpi, KpiRow } from '@/components/Kpi';
import { LiveTicker, type TickerItem, type TickerKind } from '@/components/LiveTicker';
import { PausedBadge } from '@/components/PausedBadge';
import { Sparkline } from '@/components/Sparkline';
import { apiClient } from '@/lib/api-client';
import { useTimeseries } from '@/lib/use-timeseries';
import { useUserStream } from '@/lib/use-user-stream';
import { cn } from '@/lib/utils';
import type { Alert } from '@agentscope/shared';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

interface AgentRow {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: 'live' | 'stale' | 'failed';
  alertsPausedUntil: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  recentTxCount24h: number;
  solDelta24h: string;
  successRate24h: number | null;
}

interface AlertRow extends Alert {
  agentName?: string | null;
}

interface OverviewStats {
  tx24h: number;
  solDelta24h: string;
  successRate24h: number | null;
  activeAgents: number;
  criticalAlerts: number;
}

const ALERT_LIMIT = 20;

/**
 * Landing page inside the dashboard. Aggregates agent + alert state into a
 * glance-able strip of KPIs, a live ticker, and a top-agents list.
 *
 * All data flows through react-query, so SSE invalidations on `agents` /
 * `alerts` keys automatically refresh the KPIs — no extra wiring needed.
 */
export function OverviewPage() {
  // 13.14: subscribe to /api/stream so tx/alert events push
  // invalidations into react-query. Prior to this, alerts and stats
  // refetched every 30s; with SSE in place the ticker now updates in
  // well under a second and the poll is gone. Background tabs still
  // refresh on refocus via react-query's built-in refetchOnWindowFocus,
  // and the hook reconnects with exponential backoff on any drop.
  useUserStream();

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });

  const alertsQuery = useQuery({
    queryKey: ['alerts', { limit: ALERT_LIMIT }],
    queryFn: () => apiClient.get<{ alerts: AlertRow[] }>(`/api/alerts?limit=${ALERT_LIMIT}`),
  });

  const statsQuery = useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: () => apiClient.get<OverviewStats>('/api/stats/overview'),
  });

  const txSeries = useTimeseries({ metric: 'tx' });
  const pnlSeries = useTimeseries({ metric: 'solDelta' });

  const agents = agentsQuery.data?.agents ?? [];
  const alerts = alertsQuery.data?.alerts ?? [];
  const stats = statsQuery.data;

  const liveCount = agents.filter((a) => a.status === 'live').length;
  const staleCount = agents.filter((a) => a.status === 'stale').length;
  const failedCount = agents.filter((a) => a.status === 'failed').length;

  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const warningAlerts = alerts.filter((a) => a.severity === 'warning');

  const pnl24h = stats ? Number.parseFloat(stats.solDelta24h) : 0;
  const pnlKind: 'pos' | 'neg' | 'dim' = pnl24h > 0 ? 'pos' : pnl24h < 0 ? 'neg' : 'dim';
  const pnlDelta = stats
    ? stats.successRate24h != null
      ? `${Math.round(stats.successRate24h * 100)}% success`
      : 'no tx in 24h'
    : '…';

  const tickerItems = useMemo<TickerItem[]>(() => {
    return alerts.slice(0, 8).map((alert) => {
      const kind: TickerKind =
        alert.severity === 'critical'
          ? 'alert-critical'
          : alert.severity === 'warning'
            ? 'alert-warning'
            : 'alert-info';
      const time = new Date(alert.triggeredAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const item: TickerItem = {
        id: alert.id,
        kind,
        time,
        what: alert.ruleName,
      };
      if (alert.agentName) item.who = alert.agentName;
      if (alert.agentId) item.href = `/agents/${alert.agentId}`;
      return item;
    });
  }, [alerts]);

  // Serializes the current in-memory Overview state (KPIs + full agent
  // list + recent alerts) to a JSON blob and triggers a browser download.
  // Intentionally reuses data react-query already has — no extra round-trip,
  // so the file matches pixel-for-pixel what the user is looking at.
  function handleExport() {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      stats: stats ?? null,
      agents,
      alerts,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentscope-overview-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const canExport = statsQuery.isSuccess || agentsQuery.isSuccess || alertsQuery.isSuccess;

  // Rank by 24h activity (task 13.4). Ties broken by lastSeenAt so idle
  // agents still order deterministically under an all-zero window.
  const topAgents = [...agents]
    .sort((a, b) => {
      if (b.recentTxCount24h !== a.recentTxCount24h) {
        return b.recentTxCount24h - a.recentTxCount24h;
      }
      const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, 5);

  return (
    <div className="p-7">
      <PageHead>
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            Overview
          </h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            {agents.length} agents · Last 24h · Live streaming
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={!canExport}
            title="Download a JSON snapshot of the current Overview state"
            className={cn(btnGhost, 'disabled:opacity-50 disabled:cursor-not-allowed')}
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export</span>
          </button>
          <Link to="/agents" className={btnPrimary}>
            <Plus className="h-3.5 w-3.5" />
            <span>New agent</span>
          </Link>
        </div>
      </PageHead>

      <KpiRow>
        <Kpi
          label="Tx · 24h"
          value={stats ? stats.tx24h : '…'}
          delta={stats ? `${agents.length} agents tracked` : 'loading'}
          deltaKind="dim"
          spark={txSeries.sparkPoints}
        />
        <Kpi
          label="Cumulative PnL"
          value={stats ? formatSol(pnl24h) : '…'}
          delta={pnlDelta}
          deltaKind={pnlKind}
          spark={pnlSeries.sparkPoints}
        />
        <Kpi
          label="Active Agents"
          value={stats ? `${stats.activeAgents}/${agents.length}` : `${liveCount}/${agents.length}`}
          delta={staleCount + failedCount > 0 ? `${staleCount + failedCount} idle` : 'all healthy'}
          deltaKind={staleCount + failedCount > 0 ? 'dim' : 'pos'}
        />
        <Kpi
          label="Critical Alerts"
          value={stats ? stats.criticalAlerts : criticalAlerts.length}
          delta={
            (stats?.criticalAlerts ?? criticalAlerts.length) > 0 ? 'unresolved · 24h' : 'all clear'
          }
          deltaKind={(stats?.criticalAlerts ?? criticalAlerts.length) > 0 ? 'neg' : 'pos'}
        />
      </KpiRow>

      <div className="mb-5 grid grid-cols-[1.6fr_1fr] gap-4 max-[1100px]:grid-cols-1">
        <Card
          title="Top Agents · by recent activity"
          meta={`${topAgents.length} shown · click to open`}
        >
          {topAgents.length > 0 ? (
            <div className="flex flex-col">
              {topAgents.map((agent, i) => (
                <Link
                  key={agent.id}
                  to={`/agents/${agent.id}`}
                  className="grid grid-cols-[28px_1fr_auto_auto] items-center gap-3 border-b border-line-soft px-4 py-3 last:border-b-0 hover:bg-surface-3"
                >
                  <span className="font-mono text-[10px] text-fg-3">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium text-fg">
                        {agent.name}
                      </span>
                      <StatusBadge status={agent.status} />
                      <PausedBadge alertsPausedUntil={agent.alertsPausedUntil} />
                    </div>
                    <div className="truncate font-mono text-[11.5px] text-fg-3">
                      {agent.walletPubkey}
                    </div>
                  </div>
                  <span
                    className="font-mono text-[11px] text-fg-2"
                    title="Transactions in last 24h"
                  >
                    {agent.recentTxCount24h} tx·24h
                  </span>
                  <span className="font-mono text-[11px] text-fg-3">
                    {agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : 'never'}
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState label="No agents registered yet" cta="Register one" href="/agents" />
          )}
        </Card>

        <Card title="Live Stream" meta="recent alerts">
          <div className="px-4 pb-4">
            <LiveTicker items={tickerItems} emptyLabel="waiting for events…" />
          </div>
        </Card>
      </div>

      <Card title="Pipeline Health" meta="24h rolling · snapshot">
        <div className="grid grid-cols-3 gap-6 px-5 py-4 max-[760px]:grid-cols-1">
          <MiniStat
            label="Live / Stale / Failed"
            value={`${liveCount} · ${staleCount} · ${failedCount}`}
            spark={txSeries.sparkPoints}
          />
          <MiniStat
            label="Alert severities"
            value={`${criticalAlerts.length}·${warningAlerts.length}·${
              alerts.length - criticalAlerts.length - warningAlerts.length
            }`}
          />
          <MiniStat label="Registered agents" value={agents.length} spark={pnlSeries.sparkPoints} />
        </div>
      </Card>
    </div>
  );
}

function PageHead({ children }: { children: React.ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4">{children}</div>;
}

interface CardProps {
  title: string;
  meta?: string;
  children: React.ReactNode;
}

function Card({ title, meta, children }: CardProps) {
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

interface MiniStatProps {
  label: string;
  value: React.ReactNode;
  spark?: number[];
}

function MiniStat({ label, value, spark }: MiniStatProps) {
  // 13.10 wired the Sparkline to real buckets from /api/stats/timeseries.
  // Short series (< 2 points, or all-zero fleet) cause Sparkline to render
  // nothing, which is correct: a flat zero line would misrepresent the data.
  return (
    <div className="relative">
      <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">{label}</div>
      <div className="mt-2 font-mono text-lg">{value}</div>
      {spark && spark.length >= 2 ? (
        <div className="absolute right-0 top-0">
          <Sparkline points={spark} width={80} height={28} />
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ label, cta, href }: { label: string; cta: string; href: string }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-[13px] text-fg-3">{label}</p>
      <Link
        to={href}
        className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:underline"
      >
        → {cta}
      </Link>
    </div>
  );
}

const btnPrimary = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] bg-accent px-2.5 font-mono text-[11.5px] font-medium tracking-tight',
  'text-[color:var(--primary-foreground)] hover:brightness-110 transition-[filter]',
);

const btnGhost = cn(
  'inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-line bg-surface-2 px-2.5',
  'font-mono text-[11.5px] font-medium tracking-tight text-fg-2 hover:text-fg hover:border-fg-3 hover:bg-surface-3 transition-colors',
);

function formatSol(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '' : '';
  // 3 fractional digits feel right for a KPI glance — lamport precision is
  // overkill and a raw signed number with 9 decimals looks like noise.
  return `${sign}${value.toFixed(3)} SOL`;
}

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
