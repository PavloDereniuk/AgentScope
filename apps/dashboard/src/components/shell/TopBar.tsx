import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { useSseStatus } from '@/hooks/use-sse-status';
import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';

export function TopBar() {
  const crumbs = useBreadcrumbs();
  const sseStatus = useSseStatus();

  return (
    <div className="sticky top-0 z-20 flex items-center gap-4 border-b border-line bg-surface px-7 py-3.5">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 font-mono text-xs text-fg-3">
        {crumbs.map((crumb, i) => (
          <Fragment key={`${crumb.label}-${i}`}>
            {i > 0 ? <span className="text-fg-3">/</span> : null}
            {crumb.href ? (
              <Link to={crumb.href} className="transition-colors hover:text-fg-2">
                {crumb.label}
              </Link>
            ) : (
              <span className={i === crumbs.length - 1 ? 'text-fg' : undefined}>{crumb.label}</span>
            )}
          </Fragment>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <LivePill status={sseStatus} />
        <SearchBox />
      </div>
    </div>
  );
}

function LivePill({
  status,
}: { status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }) {
  const label =
    status === 'connected'
      ? 'streaming · SSE'
      : status === 'reconnecting'
        ? 'reconnecting…'
        : status === 'connecting'
          ? 'connecting…'
          : 'offline';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-1 font-mono text-[11px]',
        status === 'connected' ? 'text-fg-2' : 'text-fg-3',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'connected'
            ? 'animate-accent-pulse bg-accent'
            : status === 'reconnecting'
              ? 'bg-warn'
              : 'bg-fg-3',
        )}
      />
      {label}
    </span>
  );
}

function SearchBox() {
  return (
    <label
      className={cn(
        'flex w-[280px] items-center gap-2 rounded-[5px] border border-line bg-surface-2 px-2.5 py-1.5',
        'font-mono text-xs text-fg-3',
      )}
    >
      <Search className="h-3 w-3 shrink-0" />
      <input
        type="search"
        placeholder="Search agents, tx, traces…"
        className="flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3"
        // MVP: visual-only — wired up post-submission.
        onChange={() => {}}
      />
      <kbd className="rounded-sm border border-line px-1 py-px text-[10px] text-fg-3">⌘K</kbd>
    </label>
  );
}
