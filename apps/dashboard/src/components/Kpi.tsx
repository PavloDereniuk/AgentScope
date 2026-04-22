import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

export type KpiDeltaKind = 'pos' | 'neg' | 'dim';

interface KpiProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaKind?: KpiDeltaKind;
  /** `sm` uses a smaller value font — for string values like rule names. */
  variant?: 'default' | 'sm';
  spark?: number[];
}

/**
 * Dashboard KPI cell. Designed to sit inside a `KpiRow` grid where
 * each cell shares a right border with its neighbour. Value is mono,
 * delta is semantic-coloured, sparkline floats top-right.
 */
export function Kpi({ label, value, delta, deltaKind, variant = 'default', spark }: KpiProps) {
  return (
    <div className="relative border-r border-line px-[18px] py-4 last:border-r-0">
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-fg-3">
        {label}
      </div>
      <div
        className={cn(
          'font-mono font-medium tracking-[-0.025em] leading-none',
          variant === 'sm' ? 'text-sm leading-tight' : 'text-2xl',
        )}
      >
        {value}
      </div>
      {delta ? (
        <div
          className={cn(
            'mt-1.5 font-mono text-[11px]',
            deltaKind === 'neg' ? 'text-crit' : deltaKind === 'dim' ? 'text-fg-3' : 'text-accent',
          )}
        >
          {delta}
        </div>
      ) : null}
      {spark ? (
        <div className="absolute right-4 top-3.5">
          <Sparkline points={spark} />
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal strip that wraps four KPI cells in a bordered card. */
export function KpiRow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 grid grid-cols-4 overflow-hidden rounded-md border border-line bg-surface-2 max-[1100px]:grid-cols-2 max-[760px]:grid-cols-1">
      {children}
    </div>
  );
}
