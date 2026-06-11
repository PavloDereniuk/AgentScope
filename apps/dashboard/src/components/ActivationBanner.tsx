import { cn } from '@/lib/utils';
import { X, Zap } from 'lucide-react';

interface ActivationBannerProps {
  onDismiss: () => void;
}

/**
 * Persistent onboarding nudge shown on agent-detail when the agent has
 * never received any tx or span (lastSeenAt == null && recentTxCount == 0).
 * Auto-hidden by the parent once data arrives; dismissible manually.
 * Warn-tint palette mirrors PausedBadge — deliberate state, not failure.
 */
export function ActivationBanner({ onDismiss }: ActivationBannerProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 rounded-md border px-4 py-3',
        'border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))]',
        'bg-[color:color-mix(in_oklch,var(--warn)_6%,var(--bg-2))]',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Zap className="mt-[1px] h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
        <p className="font-mono text-[12px] leading-relaxed">
          <span className="font-medium text-warn">Step 2 · Start sending data</span>
          <span className="text-fg-2">
            {' '}
            — use the integration snippet below to wire up your agent. This banner disappears
            automatically once AgentScope receives your first trace.
          </span>
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss activation banner"
        onClick={onDismiss}
        className="shrink-0 text-fg-3 transition-colors hover:text-fg"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
