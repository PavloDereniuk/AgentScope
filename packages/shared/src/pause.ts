/**
 * Per-agent alert-delivery pause helpers.
 *
 * The pause state lives in `agents.alerts_paused_until` (timestamptz, nullable).
 * Semantics:
 *   - null            → notifications are active.
 *   - future timestamp → paused until that moment.
 *   - past timestamp  → effectively unpaused (auto-resume; no sweep needed —
 *                       the gate compares with `now` at delivery time).
 *
 * The sentinel `9999-12-31T23:59:59.999Z` represents "paused indefinitely" so
 * the column stays a single timestamp and the API does not need a separate
 * boolean. Anything within ~1000 years of that sentinel is treated as
 * "forever" by the dashboard for display purposes.
 */

/**
 * ISO-8601 timestamp used to represent "paused forever". JS `Date` happily
 * round-trips this through `new Date(...).toISOString()`, and Postgres
 * timestamptz stores it without overflow.
 */
export const PAUSE_FOREVER = '9999-12-31T23:59:59.999Z';

/**
 * Year threshold above which a `pausedUntil` value is treated as the
 * indefinite sentinel for display purposes. Picked far below 9999 so any
 * realistic future preset stays "timed", and far above any plausible
 * timed pause so accidental year-3000 picks do not silently flip into
 * "forever".
 */
const FOREVER_YEAR_THRESHOLD = 9000;

/**
 * Returns true when `pausedUntil` is a non-null timestamp strictly after `now`.
 * Past or null values yield false (auto-resume / never paused).
 *
 * Invalid date strings are treated as "not paused" rather than throwing —
 * the gate is a safety check, not a validator. Inputs are validated at the
 * API edge by `agentSchema` / `updateAgentInputSchema`.
 */
export function isAlertsPaused(pausedUntil: string | null | undefined, now: Date): boolean {
  if (!pausedUntil) return false;
  const t = Date.parse(pausedUntil);
  if (Number.isNaN(t)) return false;
  return t > now.getTime();
}

/**
 * True iff the value represents the "paused indefinitely" sentinel. Used by
 * the dashboard to swap "Paused until <date>" for "Paused indefinitely".
 */
export function isPausedForever(pausedUntil: string | null | undefined): boolean {
  if (!pausedUntil) return false;
  const d = new Date(pausedUntil);
  return d.getUTCFullYear() >= FOREVER_YEAR_THRESHOLD;
}
