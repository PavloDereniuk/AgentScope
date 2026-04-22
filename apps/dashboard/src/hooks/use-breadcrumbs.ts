import { apiClient } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useLocation, useParams } from 'react-router-dom';

export interface Crumb {
  label: string;
  href?: string;
}

interface AgentSummary {
  id: string;
  name: string;
}

const STATIC_LABELS: Record<string, string> = {
  '/': 'overview',
  '/agents': 'agents',
  '/reasoning': 'reasoning',
  '/alerts': 'alerts',
  '/settings': 'settings',
};

/**
 * Derive a breadcrumb trail from the current route. Dynamic segments (like
 * the agent id on /agents/:id) resolve to the agent's name via react-query;
 * while that lookup is in flight we show a stable mono-id fallback so the
 * TopBar doesn't thrash.
 */
export function useBreadcrumbs(): Crumb[] {
  const location = useLocation();
  const params = useParams<{ id?: string }>();

  const agentId = params.id;
  const isAgentDetail = location.pathname.startsWith('/agents/') && agentId;

  const agentQuery = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => apiClient.get<{ agent: AgentSummary }>(`/api/agents/${agentId}`),
    enabled: Boolean(isAgentDetail),
    staleTime: 60_000,
  });

  return useMemo(() => {
    const crumbs: Crumb[] = [{ label: 'agentscope', href: '/' }];
    const staticLabel = STATIC_LABELS[location.pathname];

    if (staticLabel && location.pathname !== '/') {
      crumbs.push({ label: staticLabel });
      return crumbs;
    }
    if (location.pathname === '/') {
      crumbs.push({ label: 'overview' });
      return crumbs;
    }

    if (isAgentDetail && agentId) {
      crumbs.push({ label: 'agents', href: '/agents' });
      const name = agentQuery.data?.agent.name ?? `${agentId.slice(0, 8)}…`;
      crumbs.push({ label: name });
      return crumbs;
    }

    // Fallback: split the path so unexpected routes still render something.
    const segments = location.pathname.split('/').filter(Boolean);
    segments.forEach((segment, index) => {
      const href = `/${segments.slice(0, index + 1).join('/')}`;
      const crumb: Crumb = { label: segment };
      if (index < segments.length - 1) crumb.href = href;
      crumbs.push(crumb);
    });
    return crumbs;
  }, [location.pathname, isAgentDetail, agentId, agentQuery.data]);
}
