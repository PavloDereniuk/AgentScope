/**
 * Tiny presentation helpers shared across routes. Extracted from the
 * individual pages so behaviour stays consistent (agent list vs overview
 * both render "2m ago" the same way) and the logic is unit-testable
 * without a DOM.
 */

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Email (`user@host`) → `US`; bare identifier → first two chars;
 * everything else → fallback `AS`.
 */
export function computeInitials(input: string): string {
  if (!input) return 'AS';
  const cleaned = input.replace(/[^a-zA-Z0-9@.]/g, '');
  if (cleaned.includes('@')) {
    const local = cleaned.split('@')[0] ?? cleaned;
    return local.slice(0, 2).toUpperCase() || 'AS';
  }
  return cleaned.slice(0, 2).toUpperCase() || 'AS';
}

/** Shorten a long base58 signature for table rendering — keeps both ends visible. */
export function shortenSignature(sig: string): string {
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}

/**
 * Structured display form of a parsed instruction name. The persisted
 * `<namespace>.<op>` form (e.g. `system.transfer`, `kamino.deposit`)
 * is precise but reads like a code identifier. We split it into a
 * bold "action" word + an optional protocol suffix the renderer can
 * style ("Swap · Jupiter", "Deposit · Kamino").
 *
 * `muted=true` flags utility / fallback labels (Compute Budget,
 * kamino.refresh_*, bare friendly names like "System", "Token") that
 * the renderer should dim so the eye skips past them.
 */
export interface FormattedInstruction {
  action: string;
  protocol?: string;
  muted?: boolean;
}

/** Namespace → human protocol name. System is intentionally absent —
 * "Transfer" alone reads better than "Transfer · System". */
const PROTOCOL_NAMES: Record<string, string> = {
  jupiter: 'Jupiter',
  kamino: 'Kamino',
};

/** Direct overrides for `<namespace>.<op>` pairs whose snake_case op
 * doesn't humanize cleanly via title-case alone. */
const ACTION_OVERRIDES: Record<string, string> = {
  'system.transfer': 'Transfer',
  'system.transfer_with_seed': 'Transfer',
  'system.create_account': 'Create Account',
  'system.create_account_with_seed': 'Create Account',
  'system.allocate': 'Allocate',
};

/** Bare friendly names from KNOWN_PROGRAMS that get a presentation tweak. */
const BARE_NAME_OVERRIDES: Record<string, FormattedInstruction> = {
  'Bubblegum (cNFT)': { action: 'cNFT' },
  'Compute Budget': { action: 'Compute Budget', muted: true },
};

/** Bare names that aren't the user-intent — always muted. */
const MUTED_BARE_NAMES = new Set([
  'System',
  'Token',
  'Token-2022',
  'Associated Token',
  'Memo',
  'Stake',
  'Vote',
  'Address Lookup Table',
  'Account Compression',
  'SPL Noop',
  'Token Metadata',
]);

function titleCase(snake: string): string {
  if (!snake) return snake;
  return snake
    .split('_')
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function formatInstructionName(raw: string | null | undefined): FormattedInstruction {
  if (!raw) return { action: '—', muted: true };

  // Bare friendly name from KNOWN_PROGRAMS (no dot in the name).
  if (!raw.includes('.')) {
    const override = BARE_NAME_OVERRIDES[raw];
    if (override) return override;
    if (MUTED_BARE_NAMES.has(raw)) return { action: raw, muted: true };
    // Recognized protocol bare names ("Jupiter v6", "Kamino Lend") —
    // surface as-is; they're informative enough.
    return { action: raw };
  }

  const dotIndex = raw.indexOf('.');
  const ns = raw.slice(0, dotIndex);
  const op = raw.slice(dotIndex + 1);
  const protocol = PROTOCOL_NAMES[ns];

  // <namespace>.unknown — we know the protocol but not the op.
  if (op === 'unknown') {
    if (protocol) return { action: protocol, protocol: '(other)', muted: true };
    return { action: ns, protocol: '(other)', muted: true };
  }

  // Direct override for awkward snake_case ops.
  const override = ACTION_OVERRIDES[raw];
  if (override) {
    return protocol ? { action: override, protocol } : { action: override };
  }

  // Kamino utility ops — collapse refresh_* / init_* into a single
  // muted "Refresh" / "Init" so they don't clutter the timeline.
  if (ns === 'kamino' && (op.startsWith('refresh_') || op.startsWith('init_'))) {
    const action = op.startsWith('refresh_') ? 'Refresh' : 'Init';
    return { action, protocol: 'Kamino', muted: true };
  }

  const action = titleCase(op);
  return protocol ? { action, protocol } : { action };
}
