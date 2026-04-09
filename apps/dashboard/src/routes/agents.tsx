import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { Bot, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

interface AgentRow {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: 'live' | 'stale' | 'failed';
  lastSeenAt: string | null;
  createdAt: string;
}

const statusColor: Record<string, 'default' | 'secondary' | 'destructive'> = {
  live: 'default',
  stale: 'secondary',
  failed: 'destructive',
};

export function AgentsPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
  });

  const agents = data?.agents ?? [];
  const filtered = search
    ? agents.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.walletPubkey.toLowerCase().includes(search.toLowerCase()),
      )
    : agents;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Agents</h1>
        <Button asChild>
          <Link to="/agents/new">
            <Plus className="mr-2 h-4 w-4" />
            Add Agent
          </Link>
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or wallet..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {isLoading && <p className="text-muted-foreground">Loading agents...</p>}

      {error && (
        <p className="text-destructive">Failed to load agents: {(error as Error).message}</p>
      )}

      {!isLoading && filtered.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12">
            <Bot className="h-12 w-12 text-muted-foreground" />
            <p className="text-muted-foreground">
              {search ? 'No agents match your search.' : 'No agents registered yet.'}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3">
        {filtered.map((agent) => (
          <Link key={agent.id} to={`/agents/${agent.id}`}>
            <Card className="transition-colors hover:bg-accent/30">
              <CardContent className="flex items-center gap-4 p-4">
                <Bot className="h-8 w-8 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{agent.name}</span>
                    <Badge variant={statusColor[agent.status] ?? 'secondary'}>{agent.status}</Badge>
                    <Badge variant="outline" className="text-xs">
                      {agent.framework}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{agent.walletPubkey}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <p>{agent.agentType}</p>
                  <p>
                    {agent.lastSeenAt
                      ? `Last seen ${new Date(agent.lastSeenAt).toLocaleDateString()}`
                      : 'Never seen'}
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
