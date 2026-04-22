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
