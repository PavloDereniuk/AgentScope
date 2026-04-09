import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2, Plus, Search } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
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
}

const statusColor: Record<string, 'default' | 'secondary' | 'destructive'> = {
  live: 'default',
  stale: 'secondary',
  failed: 'destructive',
};

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
      name: fd.get('name') as string,
      walletPubkey: fd.get('walletPubkey') as string,
      framework: fd.get('framework') as string,
      agentType: fd.get('agentType') as string,
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Add Agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Agent</DialogTitle>
          <DialogDescription>Add a new AI agent to monitor.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="agent-name" className="text-sm font-medium">
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
            <label htmlFor="agent-wallet" className="text-sm font-medium">
              Wallet Public Key
            </label>
            <Input id="agent-wallet" name="walletPubkey" placeholder="So1ana..." required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="agent-framework" className="text-sm font-medium">
                Framework
              </label>
              <select
                id="agent-framework"
                name="framework"
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {FRAMEWORKS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label htmlFor="agent-type" className="text-sm font-medium">
                Type
              </label>
              <select
                id="agent-type"
                name="agentType"
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {AGENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {mutation.error && (
            <p className="text-sm text-destructive">{(mutation.error as Error).message}</p>
          )}
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
        <AddAgentDialog />
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
