/**
 * Thin wrapper around <TraceDetailPanel> for the tx-detail context.
 *
 * The tx-detail endpoint (`GET /api/transactions/:signature`) already
 * returns spans correlated with the transaction, so we hand the spans
 * directly to TraceDetailPanel rather than triggering a second fetch
 * by traceId. This keeps a single rendering path for every reasoning
 * surface in the dashboard — see TraceDetailPanel for the full UI.
 */

import { TraceDetailPanel } from '@/components/TraceDetailPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import type { TraceSpan } from '@/lib/build-trace-tree';
import { useQuery } from '@tanstack/react-query';

export function ReasoningTree({ signature }: { signature: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tx-reasoning', signature],
    queryFn: () =>
      apiClient.get<{ transaction: unknown; reasoningLogs: TraceSpan[] }>(
        `/api/transactions/${signature}`,
      ),
  });

  const spans = data?.reasoningLogs ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reasoning Trace</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading spans...</p>
        ) : (
          <TraceDetailPanel spans={spans} emptyHint="No reasoning logs for this transaction." />
        )}
      </CardContent>
    </Card>
  );
}
