import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import {
  formatAlertDetails,
  formatAlertSummary,
  formatRuleTitle,
  isOnChainSignature,
} from '@agentscope/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';
import { useState } from 'react';
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

const severityVariant: Record<Severity, 'default' | 'secondary' | 'destructive'> = {
  info: 'secondary',
  warning: 'default',
  critical: 'destructive',
};

const SeverityIcon = ({ severity }: { severity: Severity }) => {
  if (severity === 'critical') return <AlertTriangle className="h-4 w-4 text-destructive" />;
  if (severity === 'warning') return <Bell className="h-4 w-4 text-yellow-500" />;
  return <Info className="h-4 w-4 text-muted-foreground" />;
};

/** "2h ago" / "just now" — coarse relative time for alert list subtitles. */
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

function AlertDetails({ alert }: { alert: AlertRow }) {
  const rows = formatAlertDetails(alert.ruleName, alert.payload);
  const signature = getSignature(alert.payload);

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium text-right">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={`/agents/${alert.agentId}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          View {alert.agentName} →
        </Link>
        {signature &&
          (isOnChainSignature(signature) ? (
            <a
              href={`https://solscan.io/tx/${signature}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              <span className="font-mono">{signature.slice(0, 12)}...</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title="Synthetic signature — not on-chain"
            >
              <span className="font-mono">{signature.slice(0, 12)}...</span>
              <span className="text-[10px] uppercase tracking-wide">demo</span>
            </span>
          ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Delivery: <span className="font-medium text-foreground">{alert.deliveryStatus}</span>
          {alert.deliveryChannel ? ` via ${alert.deliveryChannel}` : ''}
        </span>
        {alert.deliveredAt && (
          <span>Delivered: {new Date(alert.deliveredAt).toLocaleString()}</span>
        )}
      </div>

      {alert.deliveryError && (
        <p className="mt-2 break-all text-xs text-destructive">Error: {alert.deliveryError}</p>
      )}
    </div>
  );
}

export function AlertsPage() {
  const [filter, setFilter] = useState<Severity | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const query = filter === 'all' ? '' : `?severity=${filter}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts', filter],
    queryFn: () => apiClient.get<{ alerts: AlertRow[] }>(`/api/alerts${query}`),
    // The /api/alerts page is global (not tied to a single agent), so we
    // can't attach the per-agent SSE subscription here. Poll every 15s
    // so new alerts appear without manual refresh.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const alerts = data?.alerts ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Alerts</h1>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`rounded-md px-3 py-1 text-sm ${filter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
          >
            All
          </button>
          {SEVERITIES.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setFilter(s)}
              className={`rounded-md px-3 py-1 text-sm capitalize ${filter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">Loading alerts...</p>}

      {error && (
        <p className="text-destructive">Failed to load alerts: {(error as Error).message}</p>
      )}

      {!isLoading && alerts.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12">
            <Bell className="h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">No alerts to show.</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {alerts.map((alert) => {
          const isOpen = expandedId === alert.id;
          const triggered = new Date(alert.triggeredAt);
          return (
            <Card key={alert.id} className="overflow-hidden">
              <button
                type="button"
                onClick={() => setExpandedId(isOpen ? null : alert.id)}
                aria-expanded={isOpen}
                aria-controls={`alert-details-${alert.id}`}
                className="block w-full text-left transition-colors hover:bg-muted/40"
              >
                <CardContent className="flex items-center gap-3 p-4">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <SeverityIcon severity={alert.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{formatRuleTitle(alert.ruleName)}</span>
                      <Badge variant={severityVariant[alert.severity]}>{alert.severity}</Badge>
                      <span className="truncate text-xs text-muted-foreground">
                        · {alert.agentName}
                      </span>
                    </div>
                    <p className="truncate text-sm text-foreground/80">
                      {formatAlertSummary(alert.ruleName, alert.payload)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(alert.triggeredAt)} · {triggered.toLocaleString()}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {alert.deliveryStatus}
                  </Badge>
                </CardContent>
              </button>
              {isOpen && (
                <div id={`alert-details-${alert.id}`}>
                  <AlertDetails alert={alert} />
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
