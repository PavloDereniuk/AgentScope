import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { useState } from 'react';

interface SpanRow {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, unknown>;
  txSignature: string | null;
}

interface TreeNode {
  span: SpanRow;
  children: TreeNode[];
}

function buildTree(spans: SpanRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const span of spans) {
    byId.set(span.spanId, { span, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const span of spans) {
    const node = byId.get(span.spanId);
    if (!node) continue;
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function SpanNode({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const { span, children } = node;
  const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-accent/40"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {children.length > 0 ? (
          expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="inline-block w-3" />
        )}
        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs">{span.spanName}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{duration}ms</span>
      </button>
      {expanded &&
        children.map((child) => (
          <SpanNode key={child.span.spanId} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export function ReasoningTree({ signature }: { signature: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tx-reasoning', signature],
    queryFn: () =>
      apiClient.get<{ transaction: unknown; reasoningLogs: SpanRow[] }>(
        `/api/transactions/${signature}`,
      ),
  });

  const spans = data?.reasoningLogs ?? [];
  const tree = buildTree(spans);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reasoning Trace</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading spans...</p>}
        {!isLoading && spans.length === 0 && (
          <p className="text-sm text-muted-foreground">No reasoning logs for this transaction.</p>
        )}
        <div className="space-y-0.5">
          {tree.map((root) => (
            <SpanNode key={root.span.spanId} node={root} depth={0} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
