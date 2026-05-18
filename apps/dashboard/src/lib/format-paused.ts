/**
 * Pause-deadline formatting for the dashboard (E18.3).
 *
 * Shared by global agent pause UI (Settings PauseControls) and per-rule
 * pause UI (Settings Per-rule section + RulesPausedBadge). Pure: takes an
 * ISO timestamp + `now`, returns a string the caller can drop into a sentence.
 *
 *   formatPausedUntil('2126-01-01T00:00:00Z', now) → 'indefinitely'
 *   formatPausedUntil(<+6h>,                 now) → '6h'
 *   formatPausedUntil(<+2d 4h>,              now) → '2d 4h'
 *   formatPausedUntil(<+90d>,                now) → 'Jul 15 2026, 12:00 UTC'
 *   formatPausedUntil(<past>,                now) → ''  (auto-resume; hide)
 *   formatPausedUntil(null,                  now) → ''
 *
 * The 60-day cutoff between "relative" and "absolute UTC" is the
 * deadline-aware fallback the task spec asked for — relative time stops
 * being useful past a couple of months (nobody parses "in 87d 4h"), and
 * an absolute UTC date is short and unambiguous across locales.
 */

import { isPausedForever } from '@agentscope/shared';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatPausedUntil(pausedUntil: string | null | undefined, now: Date): string {
  if (!pausedUntil) return '';
  if (isPausedForever(pausedUntil)) return 'indefinitely';

  const ts = Date.parse(pausedUntil);
  if (Number.isNaN(ts)) return '';

  const diff = ts - now.getTime();
  if (diff <= 0) return '';

  if (diff > SIXTY_DAYS_MS) return formatAbsoluteUtc(new Date(ts));
  return humanizeMs(diff);
}

/**
 * Humanize a positive ms duration as a compact string ("47m", "23h 12m",
 * "6d 4h"). Returns "<1m" for sub-minute remainders so the UI never shows
 * an empty string for an active pause.
 */
export function humanizeMs(ms: number): string {
  if (ms < 60_000) return '<1m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/**
 * "Jul 15 2026, 12:00 UTC". Hand-rolled instead of toLocaleString so output
 * is stable across runtimes/locales (test assertions stay reliable).
 */
function formatAbsoluteUtc(d: Date): string {
  const month = MONTHS[d.getUTCMonth()] ?? '???';
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${month} ${day} ${year}, ${hh}:${mm} UTC`;
}
