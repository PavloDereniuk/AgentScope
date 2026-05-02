import { cn } from '@/lib/utils';
import { isAlertsPaused, isPausedForever } from '@agentscope/shared';
import { PauseCircle } from 'lucide-react';

/**
 * Per-agent "notifications paused" badge. Renders nothing when not paused
 * so callers can sprinkle it everywhere (lists, detail headers, overview
 * cards) without conditional wrappers.
 *
 * Tone is intentionally muted (warn-tinted, not crit) — pause is a
 * deliberate user state, not a failure. The native `title` carries the
 * exact deadline so the row stays readable at compact density without
 * needing a tooltip library.
 */
export function PausedBadge({
  alertsPausedUntil,
  className,
}: {
  alertsPausedUntil: string | null | undefined;
  className?: string;
}) {
  const now = new Date();
  if (!isAlertsPaused(alertsPausedUntil, now)) return null;

  const forever = isPausedForever(alertsPausedUntil);
  const titleSuffix = forever
    ? 'indefinitely'
    : `until ${new Date(alertsPausedUntil as string).toLocaleString()}`;

  return (
    <span
      title={`Notifications paused ${titleSuffix}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        'border-[color:color-mix(in_oklch,var(--warn)_35%,var(--line))] bg-[color:color-mix(in_oklch,var(--warn)_8%,transparent)] text-warn',
        className,
      )}
    >
      <PauseCircle className="h-2.5 w-2.5" />
      paused
    </span>
  );
}
