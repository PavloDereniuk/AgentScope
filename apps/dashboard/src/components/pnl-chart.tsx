import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

export function PnlChart({ transactions }: { transactions: TxRow[] }) {
  const data = useMemo(() => {
    const sorted = [...transactions].sort(
      (a, b) => new Date(a.blockTime).getTime() - new Date(b.blockTime).getTime(),
    );
    let cumulative = 0;
    return sorted.map<DataPoint>((tx) => {
      // A single NaN (e.g. null/empty solDelta) poisons the accumulator and
      // renders the entire chart as NaN, so guard each increment.
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
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cumulative SOL PnL</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10 }}
              className="fill-muted-foreground"
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              className="fill-muted-foreground"
              tickLine={false}
              tickFormatter={(v: number) => `${v} SOL`}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Area
              type="monotone"
              dataKey="cumulative"
              stroke="hsl(var(--primary))"
              fill="url(#pnlGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
