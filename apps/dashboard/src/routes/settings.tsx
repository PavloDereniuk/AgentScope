import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';

interface AgentRow {
  id: string;
  name: string;
  webhookUrl: string | null;
  alertRules: {
    slippagePctThreshold?: number;
    gasMultThreshold?: number;
    drawdownPctThreshold?: number;
    errorRatePctThreshold?: number;
    staleMinutesThreshold?: number;
  } | null;
}

interface AgentListResponse {
  agents: AgentRow[];
}

export function SettingsPage() {
  const [selectedId, setSelectedId] = useState<string>('');
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<AgentListResponse>('/api/agents'),
  });
  const agents = data?.agents ?? [];

  // Auto-select first agent
  useEffect(() => {
    if (!selectedId && agents.length > 0 && agents[0]) {
      setSelectedId(agents[0].id);
    }
  }, [agents, selectedId]);

  const selected = agents.find((a) => a.id === selectedId);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiClient.patch<{ agent: AgentRow }>(`/api/agents/${selectedId}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const webhookUrl = (fd.get('webhookUrl') as string) || null;
    const alertRules: Record<string, number> = {};

    const fields = [
      'slippagePctThreshold',
      'gasMultThreshold',
      'drawdownPctThreshold',
      'errorRatePctThreshold',
      'staleMinutesThreshold',
    ] as const;

    for (const field of fields) {
      const val = fd.get(field) as string;
      const num = Number(val);
      if (val && !Number.isNaN(num) && num > 0) alertRules[field] = num;
    }

    const body: Record<string, unknown> = { webhookUrl };
    if (Object.keys(alertRules).length > 0) body.alertRules = alertRules;
    mutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="space-y-2">
        <label htmlFor="agent-select" className="text-sm font-medium">
          Select Agent
        </label>
        <select
          id="agent-select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <form onSubmit={handleSubmit} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Webhook</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <label htmlFor="webhookUrl" className="text-sm font-medium">
                Webhook URL
              </label>
              <Input
                id="webhookUrl"
                name="webhookUrl"
                type="url"
                placeholder="https://example.com/webhook"
                defaultValue={selected.webhookUrl ?? ''}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Alert Rule Thresholds</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="slippagePctThreshold" className="text-sm font-medium">
                  Slippage %
                </label>
                <Input
                  id="slippagePctThreshold"
                  name="slippagePctThreshold"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 2.5"
                  defaultValue={selected.alertRules?.slippagePctThreshold ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="gasMultThreshold" className="text-sm font-medium">
                  Gas multiplier
                </label>
                <Input
                  id="gasMultThreshold"
                  name="gasMultThreshold"
                  type="number"
                  step="0.1"
                  placeholder="e.g. 3.0"
                  defaultValue={selected.alertRules?.gasMultThreshold ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="drawdownPctThreshold" className="text-sm font-medium">
                  Drawdown %
                </label>
                <Input
                  id="drawdownPctThreshold"
                  name="drawdownPctThreshold"
                  type="number"
                  step="0.1"
                  placeholder="e.g. 10"
                  defaultValue={selected.alertRules?.drawdownPctThreshold ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="errorRatePctThreshold" className="text-sm font-medium">
                  Error rate %
                </label>
                <Input
                  id="errorRatePctThreshold"
                  name="errorRatePctThreshold"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  placeholder="e.g. 20"
                  defaultValue={selected.alertRules?.errorRatePctThreshold ?? ''}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="staleMinutesThreshold" className="text-sm font-medium">
                  Stale (minutes)
                </label>
                <Input
                  id="staleMinutesThreshold"
                  name="staleMinutesThreshold"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="e.g. 60"
                  defaultValue={selected.alertRules?.staleMinutesThreshold ?? ''}
                />
              </div>
            </CardContent>
          </Card>

          {mutation.error && (
            <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
          )}
          {mutation.isSuccess && <p className="text-sm text-green-500">Settings saved.</p>}

          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Settings
          </Button>
        </form>
      )}
    </div>
  );
}
