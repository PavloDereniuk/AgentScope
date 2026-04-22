import { apiClient } from '@/lib/api-client';
import { useAuthActions } from '@/lib/auth-actions';
import { useAuth } from '@/lib/privy';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  GitBranch,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  Settings as SettingsIcon,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';

interface AgentRow {
  id: string;
  name: string;
  status: string;
}

interface AlertRow {
  id: string;
  severity: string;
}

interface NavItemDef {
  to: string;
  label: string;
  icon: LucideIcon;
  matchPaths?: string[];
  countKind?: 'agents' | 'critical-alerts';
  hotWhenCritical?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  { to: '/', label: 'overview', icon: LayoutDashboard },
  { to: '/agents', label: 'agents', icon: Bot, matchPaths: ['/agents'], countKind: 'agents' },
  { to: '/reasoning', label: 'reasoning', icon: GitBranch },
  {
    to: '/alerts',
    label: 'alerts',
    icon: AlertTriangle,
    countKind: 'critical-alerts',
    hotWhenCritical: true,
  },
  { to: '/settings', label: 'settings', icon: SettingsIcon },
];

export function Sidebar() {
  const { user } = useAuth();
  const { signOut, isSigningOut } = useAuthActions();

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => apiClient.get<{ agents: AgentRow[] }>('/api/agents'),
    staleTime: 30_000,
  });

  const criticalAlertsQuery = useQuery({
    queryKey: ['alerts', { severity: 'critical' }],
    queryFn: () => apiClient.get<{ alerts: AlertRow[] }>('/api/alerts?severity=critical&limit=100'),
    staleTime: 30_000,
  });

  const agents = agentsQuery.data?.agents ?? [];
  const criticalCount = criticalAlertsQuery.data?.alerts.length ?? 0;

  const email = user?.email?.address;
  const wallet = user?.wallet?.address;
  const display = email ?? wallet ?? 'anonymous';
  const initials = computeInitials(display);

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen w-[232px] flex-col border-r border-line bg-surface px-3 py-[18px]',
      )}
    >
      {/* Logo */}
      <div className="mb-4 flex items-center gap-[10px] border-b border-line px-[10px] pb-5 pt-[6px] font-mono text-sm font-semibold">
        <span className="grid h-5 w-5 place-items-center rounded-[4px] bg-accent">
          <span className="h-2 w-2 rounded-full bg-surface ring-[1.5px] ring-surface" />
        </span>
        <span>agentscope</span>
        <sup className="ml-1 text-[9px] font-medium tracking-[0.08em] text-fg-3">v0.9</sup>
      </div>

      {/* Workspace nav */}
      <SectionLabel>Workspace</SectionLabel>
      <nav className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const count =
            item.countKind === 'agents'
              ? agents.length
              : item.countKind === 'critical-alerts'
                ? criticalCount
                : undefined;
          const hot = item.hotWhenCritical ? criticalCount > 0 : false;

          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => sideItemClass(isActive || matchesAny(item.matchPaths))}
            >
              {({ isActive }) => (
                <>
                  {hot ? (
                    <span
                      aria-hidden
                      className="h-[7px] w-[7px] shrink-0 rounded-full bg-crit shadow-[0_0_0_3px_color-mix(in_oklch,var(--crit)_25%,transparent)]"
                    />
                  ) : (
                    <item.icon className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span>{item.label}</span>
                  {count !== undefined ? <NumBadge active={isActive}>{count}</NumBadge> : null}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Recent agents */}
      {agents.length > 0 ? (
        <>
          <SectionLabel>Recent</SectionLabel>
          <nav className="flex flex-col gap-0.5">
            {agents.slice(0, 3).map((agent) => (
              <NavLink
                key={agent.id}
                to={`/agents/${agent.id}`}
                className={({ isActive }) => sideItemClass(isActive)}
              >
                <span className="text-[10px] text-fg-3">›</span>
                <span className="truncate">{agent.name}</span>
              </NavLink>
            ))}
          </nav>
        </>
      ) : null}

      {/* Bottom: user + sign out */}
      <div className="mt-auto border-t border-line pt-3">
        <div className="flex items-center gap-[10px] rounded-[5px] px-[10px] py-2 text-xs text-fg-2">
          <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-gradient-to-br from-accent to-accent-dim font-mono text-[10px] font-semibold text-surface">
            {initials}
          </span>
          <span className="truncate font-mono text-[11px]">{display}</span>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={isSigningOut}
          className={cn(
            'mt-1 flex w-full items-center gap-[10px] rounded-[5px] px-[10px] py-1.5 font-mono text-[11px] text-fg-3 transition-colors',
            'hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <LogOut className="h-3.5 w-3.5" />
          {isSigningOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </aside>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-[10px] pb-1.5 pt-[14px] font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">
      {children}
    </div>
  );
}

function NumBadge({ children, active }: { children: React.ReactNode; active: boolean }) {
  return (
    <span
      className={cn(
        'ml-auto rounded-full border border-line px-1.5 py-[1px] font-mono text-[10.5px] text-fg-3',
        active ? 'bg-surface' : 'bg-surface-2',
      )}
    >
      {children}
    </span>
  );
}

function sideItemClass(active: boolean): string {
  return cn(
    'flex items-center gap-[10px] rounded-[5px] px-[10px] py-[7px] font-mono text-[13px] tracking-tight transition-colors',
    active ? 'bg-surface-3 text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  );
}

function matchesAny(_paths: string[] | undefined): boolean {
  // Reserved for future sub-route matching (e.g. /agents/:id also lights up "agents").
  // NavLink's `end=false` default already handles simple prefix matches.
  return false;
}

function computeInitials(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9@.]/g, '');
  if (cleaned.includes('@')) {
    const local = cleaned.split('@')[0] ?? cleaned;
    return local.slice(0, 2).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase() || 'AS';
}
