import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

export type TickerKind = 'tx' | 'alert-critical' | 'alert-warning' | 'alert-info';

export interface TickerItem {
  id: string;
  kind: TickerKind;
  /** Already formatted as a short local time (e.g. "14:32:04"). */
  time: string;
  /** Primary label — rule name or instruction (`jupiter.swap`, `slippage_spike`). */
  what: string;
  /** Secondary label — agent name or short signature. */
  who?: string;
  /** Route to open on click (agent detail or tx detail). */
  href?: string;
}

interface LiveTickerProps {
  items: TickerItem[];
  /** Cap the rendered count. Defaults to 8 — longer lists become noise. */
  limit?: number;
  emptyLabel?: string;
}

/**
 * Fixed-width monospace event stream. New items prepend at the top (up to
 * `limit`). Severity dot colour-codes alerts; plain transactions use the
 * default accent dot.
 */
export function LiveTicker({ items, limit = 8, emptyLabel = 'no activity yet' }: LiveTickerProps) {
  const visible = items.slice(0, limit);

  if (visible.length === 0) {
    return <div className="py-6 text-center font-mono text-[11px] text-fg-3">{emptyLabel}</div>;
  }

  return (
    <ol className="flex flex-col gap-0.5 font-mono text-[11.5px]">
      {visible.map((item) => {
        const row = (
          <div className="grid grid-cols-[62px_12px_1fr_auto] items-center gap-2.5 py-1 text-fg-2 transition-colors hover:text-fg">
            <span className="text-[10.5px] text-fg-3">{item.time}</span>
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                item.kind === 'alert-critical'
                  ? 'bg-crit'
                  : item.kind === 'alert-warning'
                    ? 'bg-warn'
                    : item.kind === 'alert-info'
                      ? 'bg-info'
                      : 'bg-accent',
              )}
            />
            <span className="min-w-0 truncate">
              <span className="text-fg">{item.what}</span>
              {item.who ? <span className="text-fg-3"> · {item.who}</span> : null}
            </span>
            <span className="text-[10.5px] text-fg-3">→</span>
          </div>
        );

        return (
          <li key={item.id} className="animate-in fade-in slide-in-from-top-1 duration-200">
            {item.href ? <Link to={item.href}>{row}</Link> : row}
          </li>
        );
      })}
    </ol>
  );
}
