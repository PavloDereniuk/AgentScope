import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, CheckCircle2, Circle, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface OnboardingChecklistProps {
  agentToken: string;
  hasTraffic: boolean;
  onDismiss: () => void;
}

/**
 * 3-step setup checklist shown on agent-detail until the agent sends its first
 * trace. Auto-dismisses 2.5s after traffic arrives so the user briefly sees the
 * all-green state before it disappears. Dismissible manually at any time.
 *
 * Steps:
 *  1. ✅ Register agent        — always complete at render time
 *  2. ⬤  Wire up SDK + token  — active until first trace (shows token copy + npm cmd)
 *  3. ○  First trace received  — auto-checks when hasTraffic becomes true
 */
export function OnboardingChecklist({
  agentToken,
  hasTraffic,
  onDismiss,
}: OnboardingChecklistProps) {
  const [tokenCopied, setTokenCopied] = useState(false);

  useEffect(() => {
    if (!hasTraffic) return;
    const t = setTimeout(onDismiss, 2500);
    return () => clearTimeout(t);
  }, [hasTraffic, onDismiss]);

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(agentToken);
      setTokenCopied(true);
      toast.success('Token copied');
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      toast.error('Copy failed');
    }
  };

  return (
    <div
      className={cn(
        'rounded-md border px-4 py-3.5 transition-colors duration-500',
        hasTraffic
          ? 'border-[color:color-mix(in_oklch,var(--accent)_30%,var(--line))] bg-[color:color-mix(in_oklch,var(--accent)_5%,var(--bg-2))]'
          : 'border-[color:color-mix(in_oklch,var(--warn)_30%,var(--line))] bg-[color:color-mix(in_oklch,var(--warn)_5%,var(--bg-2))]',
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-2">
          {hasTraffic ? 'Setup complete' : 'Setup checklist'}
        </span>
        <button
          type="button"
          aria-label="Dismiss setup checklist"
          onClick={onDismiss}
          className="text-fg-3 transition-colors hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <ol className="space-y-2">
        <Step icon="done" label="Agent registered" />

        <Step
          icon={hasTraffic ? 'done' : 'active'}
          label={hasTraffic ? 'SDK wired up' : 'Wire up your agent'}
        >
          {!hasTraffic ? (
            <div className="mt-2 space-y-2 pl-[22px]">
              <pre className="overflow-x-auto rounded-[4px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-fg-2">
                {'npm i @agentscopehq/agent-kit-sdk'}
              </pre>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[4px] border border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-fg-2">
                  {agentToken}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 gap-1.5 px-2.5 font-mono text-[11px]"
                  onClick={copyToken}
                >
                  {tokenCopied ? (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                  ) : (
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {tokenCopied ? 'Copied' : 'Copy token'}
                </Button>
              </div>
              <p className="font-mono text-[11px] text-fg-3">
                Full snippet with ElizaOS / Agent Kit / curl below ↓
              </p>
            </div>
          ) : null}
        </Step>

        <Step
          icon={hasTraffic ? 'done' : 'waiting'}
          label={hasTraffic ? "First trace received — you're live!" : 'Awaiting first trace…'}
        />
      </ol>
    </div>
  );
}

function Step({
  icon,
  label,
  children,
}: {
  icon: 'done' | 'active' | 'waiting';
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="list-none">
      <div className="flex items-center gap-2">
        {icon === 'done' ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        ) : icon === 'active' ? (
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-warn"
          />
        ) : (
          <Circle className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden />
        )}
        <span
          className={cn(
            'font-mono text-[12px]',
            icon === 'done' ? 'text-accent' : icon === 'active' ? 'text-fg-2' : 'text-fg-3',
          )}
        >
          {label}
        </span>
      </div>
      {children}
    </li>
  );
}
