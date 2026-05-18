import { cn } from '@/lib/utils';
import {
  type AlertRuleName,
  type AlertRuleThresholds,
  isAlertsPaused,
  isRulePaused,
} from '@agentscope/shared';
import { PauseCircle } from 'lucide-react';

/**
 * Per-rule pause indicator (E18.3). Shown next to the agent header
 * alongside the existing `<PausedBadge />` (which marks agent-wide pause).
 *
 * Suppressed when:
 *   - the agent-wide pause is active (the bolder `<PausedBadge />` already
 *     covers the situation; rendering both would be noisy and redundant);
 *   - no rule entries are currently in the future (count === 0).
 *
 * Visually softer than `<PausedBadge />` — same warn family but lower
 * saturation + muted text — so "some rules paused" reads as less severe
 * than "all alerts paused".
 */
export function RulesPausedBadge({
  alertRules,
  globalPausedUntil,
  className,
}: {
  alertRules: AlertRuleThresholds | null | undefined;
  globalPausedUntil: string | null | undefined;
  className?: string;
}) {
  const now = new Date();
  if (isAlertsPaused(globalPausedUntil ?? null, now)) return null;

  const map = alertRules?.pausedUntil;
  if (!map) return null;
  const paused = (Object.keys(map) as AlertRuleName[]).filter((rule) =>
    isRulePaused(alertRules ?? null, rule, now),
  );
  if (paused.length === 0) return null;

  const label = paused.length === 1 ? '1 rule paused' : `${paused.length} rules paused`;

  return (
    <span
      title={`Paused rules: ${paused.join(', ')}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em]',
        'border-[color:color-mix(in_oklch,var(--warn)_22%,var(--line))] bg-[color:color-mix(in_oklch,var(--warn)_5%,transparent)] text-fg-2',
        className,
      )}
    >
      <PauseCircle className="h-2.5 w-2.5 text-warn" />
      {label}
    </span>
  );
}
