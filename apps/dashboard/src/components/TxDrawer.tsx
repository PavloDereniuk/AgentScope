import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

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

interface TxDetailResponse {
  transaction: {
    id: number;
    signature: string;
    blockTime: string;
    programId: string;
    instructionName: string | null;
    solDelta: string;
    success: boolean;
    feeLamports: number;
  };
  reasoningLogs: SpanRow[];
}

interface TxDrawerProps {
  signature: string | null;
  onClose: () => void;
}

const SOLSCAN_BASE = 'https://solscan.io/tx';
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

/**
 * Slide-in drawer showing full tx details + span tree + signature
 * utilities. Lives outside the page component so any row in agents
 * detail can open it without prop drilling the tx shape.
 *
 * A11y: mask click + Escape both close. Focus moves to the close
 * button on open (lightweight focus management without a full trap
 * library).
 */
export function TxDrawer({ signature, onClose }: TxDrawerProps) {
  const open = signature !== null;
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { data, isLoading } = useQuery({
    queryKey: ['tx-detail', signature],
    queryFn: () => apiClient.get<TxDetailResponse>(`/api/transactions/${signature}`),
    enabled: open,
  });

  if (!open) return null;

  const tx = data?.transaction;
  const spans = data?.reasoningLogs ?? [];
  const isOnChain = signature ? SIGNATURE_RE.test(signature) : false;

  async function handleCopy() {
    if (!signature) return;
    await navigator.clipboard.writeText(signature);
  }

  function handleDownload() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tx-${signature?.slice(0, 10) ?? 'payload'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close transaction details"
        onClick={onClose}
        className="fixed inset-0 z-[80] bg-[oklch(0%_0_0_/_0.45)] backdrop-blur-sm animate-in fade-in duration-150"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: <dialog> modal semantics drop the backdrop click-to-close pattern we rely on */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transaction details"
        className={cn(
          'fixed bottom-0 right-0 top-0 z-[81] flex w-[540px] max-w-[100vw] flex-col',
          'border-l border-line bg-surface-2',
          'animate-in slide-in-from-right duration-200',
        )}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-fg">Transaction</div>
            <div className="mt-1 truncate font-mono text-[11px] text-fg-3">
              {signature}
              {tx ? ` · ${new Date(tx.blockTime).toLocaleString()}` : ''}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 font-mono text-[11px] text-fg-3 hover:border-fg-3 hover:text-fg"
          >
            <X className="h-3 w-3" />
            esc
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-5">
          {isLoading ? (
            <p className="font-mono text-xs text-fg-3">Loading tx…</p>
          ) : !tx ? (
            <p className="font-mono text-xs text-crit">Transaction not found.</p>
          ) : (
            <>
              <div className="mb-5 grid grid-cols-2 gap-3">
                <Field label="Instruction">
                  <span className="font-mono text-[13px]">{tx.instructionName ?? '(unknown)'}</span>
                </Field>
                <Field label="Status">
                  <StatusPill ok={tx.success} />
                </Field>
                <Field label="SOL Delta">
                  <span
                    className={cn(
                      'font-mono text-[13px] tabular-nums',
                      Number(tx.solDelta) >= 0 ? 'text-accent' : 'text-crit',
                    )}
                  >
                    {Number(tx.solDelta) >= 0 ? '+' : ''}
                    {Number(tx.solDelta).toFixed(4)}
                  </span>
                </Field>
                <Field label="Fee (lamports)">
                  <span className="font-mono text-[13px] tabular-nums">
                    {tx.feeLamports.toLocaleString()}
                  </span>
                </Field>
              </div>

              <div className="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg-2 hover:text-fg hover:border-fg-3"
                >
                  <Copy className="h-3 w-3" />
                  Copy signature
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg-2 hover:text-fg hover:border-fg-3"
                >
                  <Download className="h-3 w-3" />
                  Download JSON
                </button>
                {isOnChain ? (
                  <a
                    href={`${SOLSCAN_BASE}/${signature}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg-2 hover:text-fg hover:border-fg-3"
                  >
                    Solscan →
                  </a>
                ) : (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-3">
                    demo
                  </span>
                )}
              </div>

              <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
                Reasoning Spans · {spans.length}
              </div>
              {spans.length === 0 ? (
                <p className="font-mono text-[11px] text-fg-3">No spans correlated with this tx.</p>
              ) : (
                <ul className="flex flex-col gap-1 font-mono text-[12px] text-fg-2">
                  {spans.map((span) => (
                    <li
                      key={span.spanId}
                      className="flex items-center gap-2 border-l border-line-soft pl-2"
                    >
                      <span className="truncate text-fg">{span.spanName}</span>
                      <span className="ml-auto text-[10.5px] tabular-nums text-fg-3">
                        {spanDuration(span)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-3">
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        ok
          ? 'text-accent border-[color:var(--accent-dim)] bg-[color-mix(in_oklch,var(--accent)_10%,transparent)]'
          : 'text-crit border-[color:color-mix(in_oklch,var(--crit)_35%,var(--line))]',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-accent' : 'bg-crit')} />
      {ok ? 'success' : 'fail'}
    </span>
  );
}

function spanDuration(span: SpanRow): string {
  if (!span.endTime) return '—';
  const ms = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
  return `${Math.max(0, ms)}ms`;
}
