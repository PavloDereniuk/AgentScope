import { type FormattedInstruction, formatInstructionName } from '@/lib/format';
import { cn } from '@/lib/utils';

interface InstructionLabelProps {
  /** Raw `instructionName` from the API — `system.transfer`, `kamino.deposit`, "Compute Budget", etc. */
  name: string | null | undefined;
  className?: string;
}

/**
 * Render an instruction name with the action emphasized and the
 * protocol tucked into a thin muted suffix ("Swap · Jupiter"). Utility
 * and fallback labels (Compute Budget, kamino.refresh_*, bare "System")
 * dim the whole thing so the eye skips past them in dense lists.
 *
 * Pure presentation — keeps the persisted DB form intact (the detector
 * and SQL filters still see `system.transfer`, `jupiter.swap`).
 */
export function InstructionLabel({ name, className }: InstructionLabelProps) {
  const formatted: FormattedInstruction = formatInstructionName(name);
  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1.5',
        formatted.muted ? 'text-fg-3' : 'text-fg-2',
        className,
      )}
    >
      <span className={cn('font-medium', formatted.muted ? 'text-fg-3' : 'text-fg')}>
        {formatted.action}
      </span>
      {formatted.protocol ? (
        <span className="text-[11px] text-fg-3">· {formatted.protocol}</span>
      ) : null}
    </span>
  );
}
