import { Kpi, KpiRow } from '@/components/Kpi';
import { apiClient } from '@/lib/api-client';
import { useIsOwner } from '@/lib/use-is-owner';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// ─── Response shapes (mirror apps/api/src/routes/admin.ts) ──────────────────

interface BuilderCounts {
  registered: number;
  active: number;
}

interface Overview {
  builders: BuilderCounts;
  agents: { total: number; live: number; stale: number; failed: number };
  transactions: { total: number; last24h: number };
  alerts24h: { critical: number; warning: number; info: number };
  reasoningSpansTotal: number;
}

interface MilestoneLeg {
  targets: { target: number; reached: boolean }[];
  nextTarget: number | null;
  reachedCount: number;
  progressToNext: number | null;
}

interface Milestones {
  builders: BuilderCounts;
  deadline: string | null;
  registered: MilestoneLeg;
  active: MilestoneLeg;
}

interface GrowthPoint {
  t: string;
  newUsers: number;
  newAgents: number;
  newBuilders: number;
  cumulativeBuilders: number;
}

interface Growth {
  window: string;
  baselineBuilders: number;
  points: GrowthPoint[];
}

interface Infra {
  db: {
    bytes: number | null;
    capBytes: number;
    usedPct: number | null;
    avgTxPerDay7d: number;
    projectedDaysToCap: number | null;
  };
  helius: { monitoredAgents: number; agentCeiling: number };
  ingestLagSeconds: number | null;
}

interface BuilderRow {
  userId: string;
  privyDid: string;
  email: string | null;
  createdAt: string;
  agents: number;
  tx7d: number;
  tx30d: number;
  lastTx: string | null;
  dormant: boolean;
}

interface AlertBreakdownRow {
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  count: number;
}

/** Single consolidated payload — see GET /api/admin/summary. One request
 *  instead of six parallel ones, so the panel doesn't flood the API's small
 *  connection pool and stall. */
interface AdminSummary {
  overview: Overview;
  milestones: Milestones;
  growth: Growth;
  infra: Infra;
  builders: { builders: BuilderRow[] };
  alertsBreakdown: { window: string; breakdown: AlertBreakdownRow[] };
}

/**
 * Owner-only grant-ops panel (Cluster F). Aggregates platform-wide metrics —
 * builder counts vs grant milestones, growth, infra headroom, per-builder
 * engagement — that the per-user dashboard deliberately never shows.
 *
 * Access is enforced server-side (every /api/admin/* call returns 403 to
 * non-owners); the `useIsOwner` redirect here is just UX so a non-owner who
 * deep-links to /admin lands back on Overview instead of staring at error
 * cards.
 */
export function AdminPage() {
  const { isOwner, isLoading: ownerLoading } = useIsOwner();

  const summary = useQuery({
    queryKey: ['admin', 'summary'],
    queryFn: () => apiClient.get<AdminSummary>('/api/admin/summary'),
    enabled: isOwner,
  });

  if (!ownerLoading && !isOwner) {
    return <Navigate to="/" replace />;
  }

  const o = summary.data?.overview;
  const m = summary.data?.milestones;
  const growthData = summary.data?.growth;
  const infraData = summary.data?.infra;
  const buildersData = summary.data?.builders;
  const breakdownData = summary.data?.alertsBreakdown;
  const loading = summary.isLoading;

  return (
    <div className="p-7">
      <div className="mb-6">
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
          Admin · Grant Ops
          <span className="rounded-full border border-line bg-surface-2 px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em] text-fg-3">
            owner only
          </span>
        </h1>
        <p className="mt-1.5 text-[13px] text-fg-3">
          Platform-wide metrics across every builder · Solana Foundation Ukraine grant
        </p>
      </div>

      {/* Milestone progress — the hero of this page */}
      <div className="mb-5 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <MilestoneCard
          title="Registered builders"
          hint="users with ≥1 agent"
          count={m?.builders.registered}
          leg={m?.registered}
          deadline={m?.deadline ?? null}
        />
        <MilestoneCard
          title="Active builders"
          hint="≥1 tx or reasoning span"
          count={m?.builders.active}
          leg={m?.active}
          deadline={m?.deadline ?? null}
        />
      </div>

      {/* Platform KPI strip */}
      <KpiRow>
        <Kpi
          label="Builders · reg / active"
          value={o ? `${o.builders.registered} / ${o.builders.active}` : '…'}
          delta={
            m == null
              ? '…'
              : m.registered.nextTarget != null
                ? `next: M@${m.registered.nextTarget}`
                : 'all hit'
          }
          deltaKind="dim"
        />
        <Kpi
          label="Agents"
          value={o ? o.agents.total : '…'}
          delta={
            o ? `${o.agents.live} live · ${o.agents.stale} stale · ${o.agents.failed} failed` : '…'
          }
          deltaKind="dim"
        />
        <Kpi
          label="Transactions · all-time"
          value={o ? formatCompact(o.transactions.total) : '…'}
          delta={o ? `${o.transactions.last24h} in 24h` : '…'}
          deltaKind={o && o.transactions.last24h > 0 ? 'pos' : 'dim'}
        />
        <Kpi
          label="Reasoning spans"
          value={o ? formatCompact(o.reasoningSpansTotal) : '…'}
          delta={
            o ? `${o.alerts24h.critical} crit · ${o.alerts24h.warning} warn (24h alerts)` : '…'
          }
          deltaKind={o && o.alerts24h.critical > 0 ? 'neg' : 'dim'}
        />
      </KpiRow>

      <div className="mb-5 grid grid-cols-[1.5fr_1fr] gap-4 max-[1100px]:grid-cols-1">
        <Card
          title="Builder growth · 30d"
          meta={growthData ? `${growthData.points.length} days` : ''}
        >
          <GrowthChart data={growthData} />
        </Card>
        <Card title="Infra headroom" meta="free-tier caps">
          <InfraPanel infra={infraData} loading={loading} />
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-[1.5fr_1fr] gap-4 max-[1100px]:grid-cols-1">
        <Card
          title="Builders · engagement"
          meta={buildersData ? `${buildersData.builders.length} total` : ''}
        >
          <BuildersTable rows={buildersData?.builders ?? []} loading={loading} />
        </Card>
        <Card title="Alerts · by rule × severity" meta="7d">
          <AlertsBreakdown rows={breakdownData?.breakdown ?? []} loading={loading} />
        </Card>
      </div>
    </div>
  );
}

// ─── Milestone card ─────────────────────────────────────────────────────────

function MilestoneCard({
  title,
  hint,
  count,
  leg,
  deadline,
}: {
  title: string;
  hint: string;
  count: number | undefined;
  leg: MilestoneLeg | undefined;
  deadline: string | null;
}) {
  const deadlineLabel = deadline ? formatDeadline(deadline) : null;
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface-2">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">{title}</span>
        <span className="font-mono text-[10.5px] text-fg-3">{hint}</span>
      </div>
      <div className="px-5 py-4">
        <div className="flex items-end gap-3">
          <span className="font-mono text-4xl font-medium leading-none tracking-[-0.03em]">
            {count ?? '…'}
          </span>
          {leg == null ? (
            // Distinguish "still loading" from "loaded, all targets hit" — an
            // undefined leg must NOT masquerade as the all-reached state.
            <span className="mb-1 font-mono text-[11px] text-fg-3">loading…</span>
          ) : leg.nextTarget != null ? (
            <span className="mb-1 font-mono text-[11px] text-fg-3">
              → {leg.nextTarget} for next milestone
            </span>
          ) : (
            <span className="mb-1 font-mono text-[11px] text-accent">all milestones reached ✓</span>
          )}
        </div>

        {/* Per-target ladder */}
        <div className="mt-4 flex flex-col gap-2">
          {(leg?.targets ?? []).map((t, i) => {
            const fill = leg && count !== undefined ? Math.min(1, count / t.target) : 0;
            return (
              <div key={t.target} className="flex items-center gap-3">
                <span className="w-7 shrink-0 font-mono text-[10.5px] text-fg-3">M{i + 1}</span>
                <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={cn(
                      'absolute inset-y-0 left-0 rounded-full transition-[width]',
                      t.reached ? 'bg-accent' : 'bg-[color:var(--accent-dim)]',
                    )}
                    style={{ width: `${fill * 100}%` }}
                  />
                </div>
                <span
                  className={cn(
                    'w-12 shrink-0 text-right font-mono text-[11px]',
                    t.reached ? 'text-accent' : 'text-fg-3',
                  )}
                >
                  {count ?? '–'}/{t.target}
                </span>
              </div>
            );
          })}
        </div>

        {deadlineLabel ? (
          <div className="mt-4 border-t border-line-soft pt-3 font-mono text-[11px] text-fg-3">
            deadline · {deadlineLabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Growth chart ───────────────────────────────────────────────────────────

function GrowthChart({ data }: { data: Growth | undefined }) {
  const points = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        day: p.t.slice(5, 10), // MM-DD
        builders: p.cumulativeBuilders,
        agents: p.newAgents,
      })),
    [data],
  );

  if (points.length < 2) {
    return <Empty label="Not enough history yet" />;
  }

  return (
    <div className="px-2 py-3">
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="adminGrowth" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--line-soft)" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: 'var(--fg-3)', fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 10, fill: 'var(--fg-3)', fontFamily: 'monospace' }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 11,
              fontFamily: 'monospace',
            }}
            labelStyle={{ color: 'var(--fg-2)' }}
          />
          <Area
            type="monotone"
            dataKey="builders"
            name="cumulative builders"
            stroke="var(--accent)"
            strokeWidth={1.5}
            fill="url(#adminGrowth)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Infra panel ────────────────────────────────────────────────────────────

function InfraPanel({ infra, loading }: { infra: Infra | undefined; loading: boolean }) {
  if (loading || !infra) {
    return <Empty label={loading ? 'Loading…' : 'No data'} />;
  }
  const { db, helius, ingestLagSeconds } = infra;
  const dbPct = db.usedPct;
  const heliusPct =
    helius.agentCeiling > 0 ? Math.min(1, helius.monitoredAgents / helius.agentCeiling) : 0;

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <CapacityBar
        label="Database · Supabase 500 MB"
        pct={dbPct}
        valueLabel={
          db.bytes != null ? `${formatBytes(db.bytes)} / ${formatBytes(db.capBytes)}` : 'n/a'
        }
        sub={
          db.projectedDaysToCap != null
            ? `~${db.projectedDaysToCap}d to cap · ${db.avgTxPerDay7d} tx/day`
            : 'projection unavailable'
        }
      />
      <CapacityBar
        label="Helius · monitored agents"
        pct={heliusPct}
        valueLabel={`${helius.monitoredAgents} / ${helius.agentCeiling}`}
        sub="free-tier credit ceiling (getBalance cron)"
      />
      <div className="flex items-center justify-between border-t border-line-soft pt-3">
        <span className="font-mono text-[11px] text-fg-3">ingest lag</span>
        <span
          className={cn(
            'font-mono text-[12px]',
            ingestLagSeconds == null
              ? 'text-fg-3'
              : ingestLagSeconds > 300
                ? 'text-warn'
                : 'text-accent',
          )}
        >
          {ingestLagSeconds == null ? 'no tx yet' : formatDuration(ingestLagSeconds)}
        </span>
      </div>
    </div>
  );
}

function CapacityBar({
  label,
  pct,
  valueLabel,
  sub,
}: {
  label: string;
  pct: number | null;
  valueLabel: string;
  sub: string;
}) {
  const ratio = pct == null ? 0 : Math.min(1, Math.max(0, pct));
  const tone = ratio > 0.85 ? 'bg-crit' : ratio > 0.6 ? 'bg-warn' : 'bg-accent';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-[11px] text-fg-2">{label}</span>
        <span className="font-mono text-[11px] text-fg-3">{valueLabel}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', tone)}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <div className="mt-1 font-mono text-[10px] text-fg-3">{sub}</div>
    </div>
  );
}

// ─── Builders table ─────────────────────────────────────────────────────────

function BuildersTable({ rows, loading }: { rows: BuilderRow[]; loading: boolean }) {
  if (loading) return <Empty label="Loading…" />;
  if (rows.length === 0) return <Empty label="No builders yet" />;
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-surface-2">
          <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.06em] text-fg-3">
            <th className="px-4 py-2 font-normal">builder</th>
            <th className="px-2 py-2 text-right font-normal">agents</th>
            <th className="px-2 py-2 text-right font-normal">tx 7d</th>
            <th className="px-2 py-2 text-right font-normal">tx 30d</th>
            <th className="px-4 py-2 text-right font-normal">status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.userId} className="border-b border-line-soft last:border-b-0">
              <td className="max-w-[180px] truncate px-4 py-2 font-mono text-[11px] text-fg-2">
                {b.email ?? b.privyDid}
              </td>
              <td className="px-2 py-2 text-right font-mono">{b.agents}</td>
              <td className="px-2 py-2 text-right font-mono">{b.tx7d}</td>
              <td className="px-2 py-2 text-right font-mono text-fg-3">{b.tx30d}</td>
              <td className="px-4 py-2 text-right">
                <span
                  className={cn(
                    'rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.06em]',
                    b.dormant
                      ? 'border-line text-fg-3'
                      : 'border-[color:var(--accent-dim)] text-accent',
                  )}
                >
                  {b.dormant ? 'dormant' : 'active'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Alerts breakdown ───────────────────────────────────────────────────────

function AlertsBreakdown({ rows, loading }: { rows: AlertBreakdownRow[]; loading: boolean }) {
  if (loading) return <Empty label="Loading…" />;
  if (rows.length === 0) return <Empty label="No alerts in window" />;

  // Pivot to one row per rule with severity columns.
  const byRule = new Map<string, { critical: number; warning: number; info: number }>();
  for (const r of rows) {
    const entry = byRule.get(r.rule) ?? { critical: 0, warning: 0, info: 0 };
    entry[r.severity] += r.count;
    byRule.set(r.rule, entry);
  }
  const pivoted = [...byRule.entries()].sort(
    (a, b) => b[1].critical + b[1].warning + b[1].info - (a[1].critical + a[1].warning + a[1].info),
  );

  return (
    <div className="max-h-[320px] overflow-auto px-4 py-3">
      <div className="flex flex-col gap-2">
        {pivoted.map(([rule, sev]) => (
          <div key={rule} className="flex items-center justify-between gap-3">
            <span className="truncate font-mono text-[11.5px] text-fg-2">{rule}</span>
            <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
              {sev.critical > 0 ? <Pill tone="crit">{sev.critical}</Pill> : null}
              {sev.warning > 0 ? <Pill tone="warn">{sev.warning}</Pill> : null}
              {sev.info > 0 ? <Pill tone="info">{sev.info}</Pill> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Pill({ tone, children }: { tone: 'crit' | 'warn' | 'info'; children: React.ReactNode }) {
  const cls =
    tone === 'crit'
      ? 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]'
      : tone === 'warn'
        ? 'text-warn border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))]'
        : 'text-fg-3 border-line';
  return <span className={cn('rounded-full border px-1.5 py-px', cls)}>{children}</span>;
}

// ─── Shared primitives ──────────────────────────────────────────────────────

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

function Empty({ label }: { label: string }) {
  return <div className="px-6 py-10 text-center text-[12px] text-fg-3">{label}</div>;
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function formatDeadline(iso: string): string {
  const target = new Date(iso).getTime();
  const days = Math.round((target - Date.now()) / (24 * 60 * 60 * 1000));
  const dateLabel = iso.slice(0, 10);
  if (days < 0) return `${dateLabel} (passed)`;
  return `${dateLabel} · ${days}d left`;
}
