/**
 * Slide-in drawer for a single trace. Opened from contexts where we
 * already have a traceId but not a tx signature — e.g. the
 * `Reasoning · recent` panel on agent-detail. Reuses the underlying
 * TraceDetailPanel so the rendered span tree is identical to the
 * inline expand on /reasoning and the tx-correlated tree in
 * TxDrawer.
 *
 * A11y mirrors TxDrawer: backdrop click + Escape close, focus moves
 * to the close button on open.
 */

import { TraceDetailPanel } from '@/components/TraceDetailPanel';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface TraceDrawerProps {
  traceId: string | null;
  onClose: () => void;
}

export function TraceDrawer({ traceId, onClose }: TraceDrawerProps) {
  const open = traceId !== null;
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

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close trace details"
        onClick={onClose}
        className="fixed inset-0 z-[80] bg-[oklch(0%_0_0_/_0.45)] backdrop-blur-sm animate-in fade-in duration-150"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: <dialog> modal semantics drop the backdrop click-to-close pattern we rely on */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Trace details"
        className={cn(
          'fixed bottom-0 right-0 top-0 z-[81] flex w-[640px] max-w-[100vw] flex-col',
          'border-l border-line bg-surface-2',
          'animate-in slide-in-from-right duration-200',
        )}
      >
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-fg">Trace</div>
            <div className="mt-1 truncate font-mono text-[11px] text-fg-3">{traceId}</div>
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

        <div className="flex-1 overflow-auto px-3 py-4">
          <TraceDetailPanel traceId={traceId} />
        </div>
      </div>
    </>
  );
}
