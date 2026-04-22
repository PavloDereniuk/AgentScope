import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface TxRow {
  id: number;
  blockTime: string;
  solDelta: string;
}

interface DataPoint {
  time: string;
  cumulative: number;
}

interface PnlChartProps {
  transactions: TxRow[];
  height?: number;
  /** Hide axes/tooltip for compact placements (e.g. overview aggregate card). */
  compact?: boolean;
}

/**
 * Cumulative SOL PnL area chart. Uses OKLCH accent via CSS variables
 * so palette swaps (Tweaks panel) recolour the gradient + stroke at
 * runtime without re-rendering the chart data.
 */
export function PnlChart({ transactions, height = 200, compact = false }: PnlChartProps) {
  const data = useMemo(() => {
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime(),
    );
    let cumulative = 0;
    return sorted.map<DataPoint>((tx) => {
      const delta = Number(tx.solDelta);
      if (Number.isFinite(delta)) cumulative += delta;
      return {
        time: new Date(tx.blockTime).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        cumulative: Number(cumulative.toFixed(4)),
      };
    });
  }, [transactions]);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center font-mono text-xs text-fg-3"
        style={{ height }}
      >
        no transactions yet
      </div>
    );
  }

  const last = data[data.length - 1];

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <defs>
            <linearGradient id="pnl-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="2 4"
            stroke="var(--line-soft)"
            strokeOpacity={compact ? 0 : 1}
            vertical={false}
          />
          {!compact && (
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
          )}
          {!compact && (
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v} SOL`}
              width={60}
            />
          )}
          {!compact && (
            <Tooltip
              cursor={{ stroke: 'var(--line)' }}
              contentStyle={{
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--fg)',
              }}
              labelStyle={{ color: 'var(--fg-3)' }}
              formatter={(v) => [`${Number(v).toFixed(4)} SOL`, 'Cumulative']}
            />
          )}
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke="var(--accent)"
            strokeWidth={1.5}
            fill="url(#pnl-gradient)"
            activeDot={{
              r: 4,
              stroke: 'var(--accent)',
              fill: 'var(--accent)',
              strokeOpacity: 0.3,
              strokeWidth: 6,
            }}
          />
        </AreaChart>
      </ResponsiveContainer>
      {last ? (
        <div className="mt-2 flex justify-between font-mono text-[10px] tracking-[0.04em] text-fg-3">
          <span>{data[0]?.time ?? ''}</span>
          <span>{last.time}</span>
        </div>
      ) : null}
    </div>
  );
}
