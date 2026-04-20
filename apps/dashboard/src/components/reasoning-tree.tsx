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

const MAX_TREE_DEPTH = 50;

function buildTree(spans: SpanRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const parentOf = new Map<string, string>();
  for (const span of spans) {
    byId.set(span.spanId, { span, children: [] });
    if (span.parentSpanId && span.parentSpanId !== span.spanId) {
      parentOf.set(span.spanId, span.parentSpanId);
    }
  }

  // Detect transitive cycles (A → B → C → A) by walking up from each span.
  // Any span that reaches itself via its parent chain is in a cycle; we
  // promote it to a root so the tree stays finite and rendering never loops.
  const inCycle = new Set<string>();
  for (const span of spans) {
    const seen = new Set<string>([span.spanId]);
    let current = parentOf.get(span.spanId);
    while (current) {
      if (seen.has(current)) {
        inCycle.add(span.spanId);
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }

  const roots: TreeNode[] = [];
  const childSet = new Set<string>();
  for (const span of spans) {
    const node = byId.get(span.spanId);
    if (!node) continue;
    const parentId = parentOf.get(span.spanId);
    const parent = parentId && !inCycle.has(span.spanId) ? byId.get(parentId) : undefined;
    if (parent && !childSet.has(span.spanId)) {
      childSet.add(span.spanId);
      parent.children.push(node);
    } else if (!parent) {
      roots.push(node);
    }
  }
  return roots;
}

function SpanNode({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const { span, children } = node;
  // Hard depth cap as a second line of defence against degenerate trees.
  if (depth > MAX_TREE_DEPTH) return null;
  const duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-label={
          children.length > 0
            ? `${expanded ? 'Collapse' : 'Expand'} span ${span.spanName}`
            : `Span ${span.spanName}`
        }
        aria-expanded={children.length > 0 ? expanded : undefined}
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
