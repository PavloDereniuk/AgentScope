import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { Activity, AlertTriangle, Bot, LogOut, Settings } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/alerts', label: 'Alerts', icon: AlertTriangle },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const { logout } = usePrivy();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 flex-col border-r bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <Activity className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold">AgentScope</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t p-2">
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
