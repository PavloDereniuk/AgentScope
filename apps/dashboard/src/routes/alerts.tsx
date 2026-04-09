import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bell, Info } from 'lucide-react';
import { useState } from 'react';

type Severity = 'info' | 'warning' | 'critical';

interface AlertRow {
  id: string;
  agentId: string;
  ruleName: string;
  severity: Severity;
  payload: Record<string, unknown>;
  triggeredAt: string;
  deliveryStatus: string;
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

export function AlertsPage() {
  const [filter, setFilter] = useState<Severity | 'all'>('all');

  const query = filter === 'all' ? '' : `?severity=${filter}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['alerts', filter],
    queryFn: () => apiClient.get<{ alerts: AlertRow[] }>(`/api/alerts${query}`),
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
        {alerts.map((alert) => (
          <Card key={alert.id}>
            <CardContent className="flex items-center gap-3 p-4">
              <SeverityIcon severity={alert.severity} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{alert.ruleName.replace(/_/g, ' ')}</span>
                  <Badge variant={severityVariant[alert.severity]}>{alert.severity}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(alert.triggeredAt).toLocaleString()} &middot; Agent{' '}
                  {alert.agentId.slice(0, 8)}...
                </p>
              </div>
              <Badge variant="outline" className="text-xs">
                {alert.deliveryStatus}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
