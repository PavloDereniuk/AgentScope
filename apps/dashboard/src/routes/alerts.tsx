import { markAlertsSeen } from '@/lib/alerts-seen';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import {
  formatAlertDetails,
  formatAlertSummary,
  formatRuleTitle,
  isOnChainSignature,
} from '@agentscope/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

type Severity = 'info' | 'warning' | 'critical';

interface AlertRow {
  id: string;
  agentId: string;
  agentName: string;
  ruleName: string;
  severity: Severity;
  payload: Record<string, unknown>;
  triggeredAt: string;
  deliveredAt: string | null;
  deliveryChannel: string | null;
  deliveryStatus: string;
  deliveryError: string | null;
}

const SEVERITIES: Severity[] = ['info', 'warning', 'critical'];

function formatRelative(iso: string, now: number = Date.now()): string {
  const diffMs = now - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

function getSignature(payload: Record<string, unknown>): string | null {
  const sig = payload.signature;
  return typeof sig === 'string' && sig.length > 0 ? sig : null;
}

export function AlertsPage() {
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [ruleFilter, setRuleFilter] = useState<string>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts', severity],
    queryFn: () =>
      apiClient.get<{ alerts: AlertRow[] }>(
        `/api/alerts${severity === 'all' ? '' : `?severity=${severity}`}`,
      ),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const alerts = data?.alerts ?? [];

  // Mark the global feed as "seen" after every successful fetch on
  // this page, so the sidebar badge collapses to 0 and stays there
  // until a brand-new alert arrives. We use the latest triggeredAt
  // (when present) to avoid race conditions with alerts that arrive
  // mid-fetch — anything strictly newer than this stamp will still be
  // counted as unseen by the sidebar.
  useEffect(() => {
    if (!data) return;
    const latest = data.alerts.reduce<number>((max, a) => {
      const t = new Date(a.triggeredAt).getTime();
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    markAlertsSeen(latest > 0 ? latest : Date.now());
  }, [data]);

  const ruleOptions = useMemo(() => {
    const set = new Set(alerts.map((a) => a.ruleName));
    return ['all', ...Array.from(set).sort()];
  }, [alerts]);
  const agentOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of alerts) map.set(a.agentId, a.agentName);
    return [
      { id: 'all', name: 'all agents' },
      ...Array.from(map.entries()).map(([id, name]) => ({ id, name })),
    ];
  }, [alerts]);

  const filtered = alerts.filter((a) => {
    if (ruleFilter !== 'all' && a.ruleName !== ruleFilter) return false;
    if (agentFilter !== 'all' && a.agentId !== agentFilter) return false;
    return true;
  });

  const counts: Record<Severity | 'all', number> = {
    all: alerts.length,
    info: alerts.filter((a) => a.severity === 'info').length,
    warning: alerts.filter((a) => a.severity === 'warning').length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
  };

  return (
    <div className="p-7">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-1.5 text-[13px] text-fg-3">
            Global feed across all agents · {counts.critical} critical · streaming
          </p>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-[260px_1fr] gap-4 max-[960px]:grid-cols-1">
        <aside className="flex flex-col gap-4">
          <FilterBlock label="Severity">
            <SeverityButton
              active={severity === 'all'}
              onClick={() => setSeverity('all')}
              label="all"
              count={counts.all}
            />
            {SEVERITIES.map((s) => (
              <SeverityButton
                key={s}
                kind={s}
                active={severity === s}
                onClick={() => setSeverity(s)}
                label={s}
                count={counts[s]}
              />
            ))}
          </FilterBlock>

          <FilterBlock label="Rule">
            <select
              value={ruleFilter}
              onChange={(e) => setRuleFilter(e.target.value)}
              className="w-full cursor-pointer bg-transparent font-mono text-[12.5px] text-fg outline-none"
            >
              {ruleOptions.map((r) => (
                <option key={r} value={r}>
                  {r === 'all' ? 'all rules' : formatRuleTitle(r)}
                </option>
              ))}
            </select>
          </FilterBlock>

          <FilterBlock label="Agent">
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="w-full cursor-pointer bg-transparent font-mono text-[12.5px] text-fg outline-none"
            >
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </FilterBlock>
        </aside>

        <section>
          {isLoading ? (
            <p className="font-mono text-xs text-fg-3">Loading alerts…</p>
          ) : error ? (
            <p className="font-mono text-xs text-crit">
              Failed to load alerts: {(error as Error).message}
            </p>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border border-line bg-surface-2 px-8 py-16 text-center font-mono text-[12px] text-fg-3">
              No alerts match the current filters.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-line bg-surface-2">
              {filtered.map((alert) => {
                const isOpen = expandedId === alert.id;
                return (
                  <div key={alert.id} className="border-b border-line-soft last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isOpen ? null : alert.id)}
                      aria-expanded={isOpen}
                      className={cn(
                        'grid w-full grid-cols-[16px_10px_160px_1fr_auto_auto] items-center gap-3.5 px-4 py-3 text-left text-[13px] transition-colors',
                        'hover:bg-surface-3',
                      )}
                    >
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 text-fg-3" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-fg-3" />
                      )}
                      <SevDot severity={alert.severity} />
                      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg-2">
                        {alert.ruleName.replace(/_/g, '·')}
                      </span>
                      <span className="min-w-0 truncate text-fg-2">
                        <span className="text-fg">
                          {formatAlertSummary(alert.ruleName, alert.payload)}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] text-fg-3">{alert.agentName}</span>
                      <span className="font-mono text-[11px] text-fg-3">
                        {formatRelative(alert.triggeredAt)}
                      </span>
                    </button>
                    {isOpen ? <AlertDetails alert={alert} /> : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FilterBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
        {label}
      </div>
      <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-2 p-2">
        {children}
      </div>
    </div>
  );
}

function SeverityButton({
  kind,
  active,
  onClick,
  label,
  count,
}: {
  kind?: Severity;
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  const dotStyle =
    kind === 'critical'
      ? 'bg-crit'
      : kind === 'warning'
        ? 'bg-warn'
        : kind === 'info'
          ? 'bg-info'
          : 'bg-fg-3';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-[5px] px-2 py-1.5 font-mono text-[11.5px] transition-colors',
        active ? 'bg-surface-3 text-fg' : 'text-fg-2 hover:bg-surface-3',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dotStyle)} />
      <span className="lowercase">{label}</span>
      <span className="ml-auto text-[10.5px] text-fg-3">{count}</span>
    </button>
  );
}

function SevDot({ severity }: { severity: Severity }) {
  const style =
    severity === 'critical'
      ? 'bg-crit shadow-[0_0_0_3px_color-mix(in_oklch,var(--crit)_25%,transparent)]'
      : severity === 'warning'
        ? 'bg-warn'
        : 'bg-info';
  return <span aria-hidden className={cn('h-2 w-2 rounded-full', style)} />;
}

function AlertDetails({ alert }: { alert: AlertRow }) {
  const rows = formatAlertDetails(alert.ruleName, alert.payload);
  const signature = getSignature(alert.payload);

  return (
    <div className="border-t border-line-soft bg-surface px-12 py-3.5 font-mono text-[12px]">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-2">
            <dt className="text-fg-3">{row.label}</dt>
            <dd className="text-right text-fg-2">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
        <Link to={`/agents/${alert.agentId}`} className="text-accent hover:underline">
          View {alert.agentName} →
        </Link>
        {signature ? (
          isOnChainSignature(signature) ? (
            <a
              href={`https://solscan.io/tx/${signature}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <span>{signature.slice(0, 12)}…</span>
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 text-fg-3" title="Synthetic">
              <span>{signature.slice(0, 12)}…</span>
              <span className="text-[10px] uppercase tracking-wider">demo</span>
            </span>
          )
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10.5px] text-fg-3">
        <span>
          Delivery: <span className="text-fg-2">{alert.deliveryStatus}</span>
          {alert.deliveryChannel ? ` via ${alert.deliveryChannel}` : ''}
        </span>
        {alert.deliveredAt ? (
          <span>Delivered: {new Date(alert.deliveredAt).toLocaleString()}</span>
        ) : null}
      </div>

      {alert.deliveryError ? (
        <p className="mt-2 break-all text-[11px] text-crit">Error: {alert.deliveryError}</p>
      ) : null}
    </div>
  );
}
