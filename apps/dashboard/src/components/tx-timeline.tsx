import { InstructionLabel } from '@/components/InstructionLabel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowDownUp, CheckCircle2, Landmark, XCircle } from 'lucide-react';

interface TxRow {
  id: number;
  signature: string;
  blockTime: string;
  programId: string;
  instructionName: string | null;
  solDelta: string;
  success: boolean;
  feeLamports: number;
}

const ixIcon: Record<string, typeof ArrowDownUp> = {
  swap: ArrowDownUp,
  route: ArrowDownUp,
  deposit: Landmark,
  withdraw: Landmark,
  deposit_reserve_liquidity: Landmark,
  redeem_reserve_collateral: Landmark,
};

function TxIcon({ name }: { name: string | null }) {
  const Icon = (name && ixIcon[name.toLowerCase()]) || ArrowDownUp;
  return <Icon className="h-4 w-4 shrink-0" />;
}

export function TxTimeline({
  transactions,
  onSelect,
}: {
  transactions: TxRow[];
  onSelect?: (signature: string) => void;
}) {
  if (transactions.length === 0) {
    return <p className="text-sm text-muted-foreground">No transactions yet.</p>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent Transactions</CardTitle>
      </CardHeader>
      <CardContent className="max-h-[480px] space-y-1 overflow-y-auto p-0 px-4 pb-4">
        {transactions.map((tx) => {
          // NaN propagates through comparisons (NaN < 0 is false), so we
          // compute the display delta once with an isFinite guard to avoid
          // rendering "NaN SOL" and miscoloring failed txs.
          const rawDelta = Number(tx.solDelta);
          const delta = Number.isFinite(rawDelta) ? rawDelta : 0;
          return (
            <button
              type="button"
              key={tx.id}
              onClick={() => onSelect?.(tx.signature)}
              aria-label={`View transaction ${tx.signature.slice(0, 16)}${tx.instructionName ? ` (${tx.instructionName})` : ''}`}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/40"
            >
              <TxIcon name={tx.instructionName} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs">{tx.signature.slice(0, 16)}...</span>
                  {tx.instructionName && (
                    <InstructionLabel name={tx.instructionName} className="text-[11px]" />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(tx.blockTime).toLocaleString()}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={`text-xs font-medium ${delta < 0 ? 'text-destructive' : 'text-green-500'}`}
                >
                  {delta >= 0 ? '+' : ''}
                  {delta.toFixed(4)} SOL
                </p>
                {tx.success ? (
                  <CheckCircle2 className="ml-auto h-3 w-3 text-green-500" />
                ) : (
                  <XCircle className="ml-auto h-3 w-3 text-destructive" />
                )}
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
