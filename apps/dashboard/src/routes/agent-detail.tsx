import { PnlChart } from '@/components/pnl-chart';
import { ReasoningTree } from '@/components/reasoning-tree';
import { TxTimeline } from '@/components/tx-timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { useStream } from '@/lib/use-stream';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowLeft, Clock, DollarSign } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

interface AgentDetail {
  id: string;
  name: string;
  walletPubkey: string;
  framework: string;
  agentType: string;
  status: string;
  // ingestToken intentionally omitted — returned only by GET /api/agents/:id
  // (settings page) and should not sit in the detail page's React Query cache.
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface AlertRow {
  id: string;
  severity: string;
  ruleName: string;
  message: string;
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

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [selectedTx, setSelectedTx] = useState<string | null>(null);

  // Subscribe to SSE for real-time updates (6.16+6.17)
  useStream(id);

  const { data, isLoading, error } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => apiClient.get<AgentDetailResponse>(`/api/agents/${id}`),
    enabled: !!id,
  });

  const { data: txData } = useQuery({
    queryKey: ['agent-tx', id],
    queryFn: () => apiClient.get<TxListResponse>(`/api/agents/${id}/transactions?limit=50`),
    enabled: !!id,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading agent...</p>;
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <p className="text-destructive">{error ? (error as Error).message : 'Agent not found'}</p>
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

  const totalSolSpent = transactions.reduce((sum, tx) => {
    const delta = Number(tx.solDelta);
    // Guard against null/empty solDelta producing NaN which would propagate
    // through the entire reduce and render "NaN" on screen.
    return Number.isFinite(delta) ? sum + delta : sum;
  }, 0);
  const successRate =
    transactions.length > 0
      ? Math.round((transactions.filter((t) => t.success).length / transactions.length) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link to="/agents">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <Badge variant="outline">{agent.framework}</Badge>
            <Badge variant="secondary">{agent.agentType}</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">{agent.walletPubkey}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Transactions (24h)</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{recentTxCount}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{successRate}%</p>
            <p className="text-xs text-muted-foreground">of {transactions.length} loaded tx</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">SOL Delta</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalSolSpent.toFixed(4)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Last Alert</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {lastAlert ? (
              <>
                <p className="text-sm font-medium">{lastAlert.ruleName}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(lastAlert.triggeredAt).toLocaleString()}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No alerts</p>
            )}
          </CardContent>
        </Card>
      </div>

      <PnlChart transactions={transactions} />

      <TxTimeline transactions={transactions} onSelect={(sig) => setSelectedTx(sig)} />

      {selectedTx && <ReasoningTree signature={selectedTx} />}
    </div>
  );
}
